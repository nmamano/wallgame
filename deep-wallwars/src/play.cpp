#include "play.hpp"

#include <folly/experimental/coro/Collect.h>
#include <folly/experimental/coro/Task.h>
#include <folly/logging/xlog.h>

#include <algorithm>
#include <fstream>
#include <iostream>
#include <random>
#include <ranges>
#include <stdexcept>

#include "game_recorder.hpp"
#include "mcts.hpp"

namespace views = std::ranges::views;

struct GameResult {
    Winner winner;
    int wasted_inferences;
};

folly::coro::Task<GameRecorder> interactive_play(Board board, InteractivePlayOptions opts) {
    std::cout << "Do you want to go first? (y/n): ";
    char first;
    std::cin >> first;

    bool human_goes_first = first == 'y';
    auto human_player = human_goes_first ? Player::Red : Player::Blue;
    auto ai_player = other_player(human_player);

    GameRecorder recorder(board, human_goes_first ? "Player" : "Deep Wallwars",
                          human_goes_first ? "Deep Wallwars" : "Player");
    MCTS mcts{opts.model,
              std::move(board),
              {.max_parallelism = opts.max_parallel_samples, .seed = opts.seed}};

    bool take_turn = !human_goes_first;
    while (true) {
        if (take_turn) {
            Board notation_board = mcts.current_board();
            auto ai_move = co_await mcts.sample_and_commit_to_move(opts.samples);
            if (ai_move) {
                recorder.record_move(ai_player, *ai_move);
            } else {
                recorder.record_winner(winner_from_player(human_player));
                break;
            }

            std::cout << ai_move->standard_notation(notation_board, ai_player)
                      << "\n";
            if (auto winner = mcts.current_board().winner(); winner != Winner::Undecided) {
                recorder.record_winner(winner);
                break;
            }
        } else {
            take_turn = true;
        }

        XLOGF(INFO, "AI thinks your position is worth {}", mcts.root_value());

        // TODO: read in standard notation instead of this ad hoc solution
        std::array<Action, 2> actions;
        for (int i = 0; i < 2; ++i) {
            std::string action_type;
            std::cin >> action_type;

            if (action_type == "step") {
                Direction dir;
                std::cin >> dir;
                actions[i] = PawnMove{Pawn::Cat, dir};
            } else if (action_type == "wall") {
                Wall wall;
                std::cin >> wall;
                actions[i] = wall;
            }
        }

        Move human_move{actions[0], actions[1]};
        mcts.force_move(human_move);
        recorder.record_move(human_player, human_move);

        if (auto winner = mcts.current_board().winner(); winner != Winner::Undecided) {
            recorder.record_winner(winner);
            break;
        }
    }

    XLOGF(INFO, "Game finished, json string: {}", recorder.to_json());
    co_return recorder;
}

folly::coro::Task<GameResult> training_play_single(Board board, EvaluationFunction evaluate1,
                                                   EvaluationFunction evaluate2, int index,
                                                   TrainingPlayOptions opts) {
    MCTS mcts1{evaluate1,
               board,
               {.max_parallelism = opts.max_parallel_samples,
                .starting_turn = opts.starting_turn,
                .starting_previous_position = opts.starting_previous_position,
                .seed = opts.seed * static_cast<std::uint32_t>(index)}};

    MCTS mcts2{evaluate2,
               board,
               {.max_parallelism = opts.max_parallel_samples,
                .starting_turn = opts.starting_turn,
                .starting_previous_position = opts.starting_previous_position,
                .seed = opts.seed * static_cast<std::uint32_t>(index)}};

    XLOGF(INFO, "Starting game {}.", index);

    // One combined chronological record per game. Every decision is recorded
    // from the tree that SEARCHED it, captured pre-commit while the root still
    // points at the decision node with its full visit statistics.
    std::vector<TrainingDecision> decisions;

    int const action_limit = opts.move_limit == 0 ? 0 : opts.move_limit * 4;
    for (int action_number = 1; action_limit == 0 || action_number <= action_limit;
         ++action_number) {
        MCTS& active = mcts1.current_turn().player == Player::Red ? mcts1 : mcts2;
        MCTS& other = mcts1.current_turn().player == Player::Red ? mcts2 : mcts1;
        Player const player = active.current_turn().player;

        MCTS::RootDisposition const disposition = active.root_disposition();
        if (disposition == MCTS::RootDisposition::Terminal) {
            Winner const winner = active.current_board().winner(active.current_turn());
            opts.on_complete({std::move(decisions), active.current_board(), active.current_turn(),
                              winner, TrainingEndReason::Terminal,
                              opts.initial_state_record},
                             index);
            co_return {winner, mcts1.wasted_inferences() + mcts2.wasted_inferences()};
        }
        if (disposition == MCTS::RootDisposition::NoLegalFirst) {
            Winner const winner = winner_from_player(other_player(player));
            opts.on_complete({std::move(decisions), active.current_board(), active.current_turn(),
                              winner, TrainingEndReason::NoLegalAction,
                              opts.initial_state_record},
                             index);
            co_return {winner, mcts1.wasted_inferences() + mcts2.wasted_inferences()};
        }
        if (disposition == MCTS::RootDisposition::ShortTurnSecond) {
            if (!active.advance_short_turn() || !other.advance_short_turn()) {
                throw std::logic_error("Self-play trees disagree on a legal short turn");
            }
            --action_number;  // The internal turn boundary is not a policy action.
            continue;
        }

        co_await active.sample(opts.samples);
        NodeInfo node = active.root_info();
        auto action = active.commit_to_action(opts.temperature);
        if (!action) {
            Winner const winner = winner_from_player(other_player(player));
            opts.on_complete({std::move(decisions), active.current_board(), active.current_turn(), winner,
                              TrainingEndReason::NoLegalAction, opts.initial_state_record}, index);
            co_return {winner, mcts1.wasted_inferences() + mcts2.wasted_inferences()};
        }
        decisions.push_back({std::move(node), *action});
        other.force_action(*action);

        // Judged against the turn after every action. Standard may walk through a capture cell
        // at mid-turn; Animal Cycle terminals are immediate under its own winner(turn) contract.
        if (Winner winner = active.current_board().winner(active.current_turn());
            winner != Winner::Undecided) {
            opts.on_complete({std::move(decisions), active.current_board(), active.current_turn(), winner,
                              TrainingEndReason::Terminal, opts.initial_state_record}, index);
            co_return {winner, mcts1.wasted_inferences() + mcts2.wasted_inferences()};
        }
    }

    XLOGF(INFO, "Game {} was ended because it hit the move limit of {}", index, opts.move_limit);
    opts.on_complete({std::move(decisions), mcts1.current_board(), mcts1.current_turn(), Winner::Undecided,
                      TrainingEndReason::MoveLimit, opts.initial_state_record}, index);
    co_return {Winner::Undecided, mcts1.wasted_inferences() + mcts2.wasted_inferences()};
}

folly::coro::Task<GameRecorder> evaluation_play_single(Board const& board, int index,
                                                       EvaluationPlayOptions opts) {
    auto const& red = index % 2 == 0 ? opts.model1 : opts.model2;
    auto const& blue = index % 2 == 0 ? opts.model2 : opts.model1;

    MCTS mcts1{red.model,
               board,
               {.max_parallelism = opts.max_parallel_samples,
                .noise_factor = opts.noise_factor,
                .seed = opts.seed * static_cast<std::uint32_t>(index)}};

    MCTS mcts2{blue.model,
               board,
               {.max_parallelism = opts.max_parallel_samples,
                .noise_factor = opts.noise_factor,
                .seed = opts.seed * static_cast<std::uint32_t>(index)}};

    XLOGF(INFO, "Starting game {} with {} as red and {} as blue.", index, red.name, blue.name);
    GameRecorder recorder(board, red.name, blue.name);

    for (int num_moves = 1; opts.move_limit == 0 || num_moves <= opts.move_limit; ++num_moves) {
        auto move1 = co_await mcts1.sample_and_commit_to_move(opts.samples);
        if (!move1) {
            recorder.record_winner(Winner::Blue);
            break;
        }

        recorder.record_move(Player::Red, *move1);
        if (auto winner = mcts1.current_board().winner(); winner != Winner::Undecided) {
            recorder.record_winner(winner);
            break;
        }

        mcts2.force_move(*move1);
        auto move2 = co_await mcts2.sample_and_commit_to_move(opts.samples);

        if (!move2) {
            recorder.record_winner(Winner::Red);
            break;
        }

        recorder.record_move(Player::Blue, *move2);
        if (auto winner = mcts2.current_board().winner(); winner != Winner::Undecided) {
            recorder.record_winner(winner);
            break;
        }

        mcts1.force_move(*move2);
    }

    XLOGF(INFO, "Game {} has concluded.", index);
    co_return recorder;
}

folly::coro::Task<std::vector<GameRecorder>> evaluation_play(Board board, int games,
                                                             EvaluationPlayOptions opts) {
    auto* executor = co_await folly::coro::co_current_executor;
    auto game_tasks = views::iota(1, games + 1) | views::transform([&](int i) {
                          return evaluation_play_single(board, i, opts).scheduleOn(executor);
                      });

    auto results = co_await folly::coro::collectAllWindowed(game_tasks, opts.max_parallel_games);

    co_return results;
}

folly::coro::Task<> training_play(Board board, int games, TrainingPlayOptions opts) {
    auto* executor = co_await folly::coro::co_current_executor;
    XLOGF(INFO, "Creating {} game tasks with max_parallel_games = {}", games,
          opts.max_parallel_games);

    if (!opts.start_positions.empty() && opts.start_positions.size() != static_cast<size_t>(games)) {
        throw std::invalid_argument("start_positions count must equal games");
    }
    auto start_positions = std::move(opts.start_positions);
    opts.start_positions.clear();
    auto game_tasks = views::iota(opts.start_game, opts.start_game + games) |
        views::transform([&](int i) {
            TrainingPlayOptions game_opts = opts;
            Board game_board = board;
            if (!start_positions.empty()) {
                auto const& start = start_positions.at(i - opts.start_game);
                game_board = start.board;
                game_opts.starting_turn = start.turn;
                game_opts.starting_previous_position = start.previous_position;
                game_opts.initial_state_record = start.record_json;
            }
            auto model1 = game_opts.model1;
            auto model2 = game_opts.model2;
            return training_play_single(std::move(game_board), std::move(model1), std::move(model2),
                                        i, std::move(game_opts)).scheduleOn(executor);
        });

    auto results = co_await folly::coro::collectAllWindowed(game_tasks, opts.max_parallel_games);
    int red_wins = 0;
    int draws = 0;
    int blue_wins = 0;
    int move_limit_games = 0;
    int wasted_inferences = 0;

    for (GameResult result : results) {
        if (result.winner == Winner::Red) {
            ++red_wins;
        } else if (result.winner == Winner::Draw) {
            ++draws;
        } else if (result.winner == Winner::Blue) {
            ++blue_wins;
        } else {
            ++move_limit_games;
        }

        wasted_inferences += result.wasted_inferences;
    }

    XLOGF(INFO, "Actual terminal W/L/D is {} / {} / {}; move-limit games: {} ({} total)",
          red_wins, blue_wins, draws, move_limit_games, games);
    XLOGF(INFO, "{} inferences were wasted.", wasted_inferences);
}

folly::coro::Task<std::pair<std::vector<size_t>, std::vector<GameRecorder>>> run_tournament_round(
    Board const& board, std::vector<size_t> const& model_indices, RankingPlayOptions const& opts) {
    auto* executor = co_await folly::coro::co_current_executor;
    std::vector<size_t> next_round;
    std::vector<GameRecorder> round_recorders;

    for (size_t i = 0; i < model_indices.size() - 1; i += 2) {
        size_t model1_idx = model_indices[i];
        size_t model2_idx = model_indices[i + 1];

        XLOGF(INFO, "Starting matchup between {} and {}", opts.models[model1_idx].name,
              opts.models[model2_idx].name);

        EvaluationPlayOptions eval_opts{
            .model1 = opts.models[model1_idx],
            .model2 = opts.models[model2_idx],
            .samples = opts.samples,
            .max_parallel_samples = opts.max_parallel_samples,
            .move_limit = opts.move_limit,
            .noise_factor = opts.noise_factor,
            .seed = static_cast<std::uint32_t>(opts.seed * (model1_idx + 1) * (model2_idx + 1))};

        auto game_tasks =
            views::iota(0, opts.games_per_matchup) | views::transform([&](int game_idx) {
                return evaluation_play_single(board, game_idx, eval_opts).scheduleOn(executor);
            });
        auto matchup_recorders = co_await folly::coro::collectAllWindowed(std::move(game_tasks),
                                                                          opts.max_parallel_games);

        auto results = tally_results(matchup_recorders);
        auto const& model1_results = results[opts.models[model1_idx].name];
        auto const& model2_results = results[opts.models[model2_idx].name];

        int model1_score = model1_results.wins + model1_results.draws / 2;
        int model2_score = model2_results.wins + model2_results.draws / 2;

        next_round.push_back(model1_score >= model2_score ? model1_idx : model2_idx);
        round_recorders.insert(round_recorders.end(), matchup_recorders.begin(),
                               matchup_recorders.end());
    }

    if (model_indices.size() % 2 == 1) {
        next_round.push_back(model_indices.back());
    }

    co_return {std::move(next_round), std::move(round_recorders)};
}

folly::coro::Task<std::vector<GameRecorder>> run_tournament(Board const& board,
                                                            RankingPlayOptions const& opts) {
    std::vector<GameRecorder> recorders;

    std::vector<size_t> model_indices(opts.models.size());
    std::iota(model_indices.begin(), model_indices.end(), 0);
    std::mt19937 rng(opts.seed);
    std::shuffle(model_indices.begin(), model_indices.end(), rng);

    int round = 1;
    while (model_indices.size() > 1) {
        XLOGF(INFO, "Starting tournament round {} with {} models", round, model_indices.size());
        auto [next_round, round_recorders] =
            co_await run_tournament_round(board, model_indices, opts);
        model_indices = std::move(next_round);
        recorders.insert(recorders.end(), round_recorders.begin(), round_recorders.end());
        ++round;
    }

    XLOGF(INFO, "Tournament winner: {}", opts.models[model_indices[0]].name);
    co_return recorders;
}

folly::coro::Task<std::vector<GameRecorder>> ranking_play(Board board, RankingPlayOptions opts) {
    std::vector<GameRecorder> all_recorders;

    for (int i = 0; i < opts.num_tournaments; ++i) {
        XLOGF(INFO, "Starting tournament {}/{}", i + 1, opts.num_tournaments);
        opts.seed = static_cast<std::uint32_t>(opts.seed * (i + 1));
        auto tournament_recorders = co_await run_tournament(board, opts);

        // Save tournament results
        std::string json = all_to_json(tournament_recorders);
        std::ofstream json_file{opts.output_folder / "games.json", std::ios_base::app};
        json_file << json;

        std::string pgn = all_to_pgn(tournament_recorders);
        std::ofstream pgn_file{opts.output_folder / "games.pgn", std::ios_base::app};
        pgn_file << pgn;

        all_recorders.insert(all_recorders.end(), tournament_recorders.begin(),
                             tournament_recorders.end());
    }

    co_return all_recorders;
}

folly::coro::Task<std::vector<GameRecorder>> round_robin_play(Board board,
                                                              RankingPlayOptions opts) {
    auto* executor = co_await folly::coro::co_current_executor;
    std::vector<GameRecorder> all_recorders;

    std::size_t const num_models = opts.models.size();
    std::size_t const total_pairs = num_models * (num_models - 1) / 2;
    std::size_t pair_index = 0;

    for (std::size_t i = 0; i < num_models; ++i) {
        for (std::size_t j = i + 1; j < num_models; ++j) {
            ++pair_index;
            XLOGF(INFO, "Round-robin pair {}/{}: {} vs {}", pair_index, total_pairs,
                  opts.models[i].name, opts.models[j].name);

            EvaluationPlayOptions eval_opts{
                .model1 = opts.models[i],
                .model2 = opts.models[j],
                .samples = opts.samples,
                .max_parallel_games = opts.max_parallel_games,
                .max_parallel_samples = opts.max_parallel_samples,
                .move_limit = opts.move_limit,
                .noise_factor = opts.noise_factor,
                .seed = static_cast<std::uint32_t>(opts.seed * (i + 1) * (j + 1))};

            auto game_tasks = views::iota(0, opts.games_per_matchup) |
                              views::transform([&](int game_idx) {
                                  return evaluation_play_single(board, game_idx, eval_opts)
                                      .scheduleOn(executor);
                              });
            auto matchup_recorders = co_await folly::coro::collectAllWindowed(
                std::move(game_tasks), opts.max_parallel_games);

            // Appended per pair rather than at the end, so a run that dies
            // partway still leaves every completed pair on disk.
            std::ofstream{opts.output_folder / "games.json", std::ios_base::app}
                << all_to_json(matchup_recorders);
            std::ofstream{opts.output_folder / "games.pgn", std::ios_base::app}
                << all_to_pgn(matchup_recorders);

            all_recorders.insert(all_recorders.end(), matchup_recorders.begin(),
                                 matchup_recorders.end());
        }
    }

    co_return all_recorders;
}

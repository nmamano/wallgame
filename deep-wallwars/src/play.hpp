#pragma once

#include <folly/experimental/coro/Task.h>

#include <cstdint>
#include <filesystem>

#include "game_recorder.hpp"
#include "gamestate.hpp"
#include "mcts.hpp"

// Called exactly once per training game with the game's decision records.
// Each NodeInfo comes from the tree that actually SEARCHED that decision
// (red decisions from red's tree, blue decisions from blue's tree), so every
// policy label is a true visit distribution - never a fast-forwarded one-hot.
// final_board is the terminal position (used to derive the game outcome).
struct TrainingDecision {
    NodeInfo node;
    Action chosen_action;
};

enum class TrainingEndReason { Terminal, NoLegalAction, MoveLimit };

struct TrainingGame {
    std::vector<TrainingDecision> decisions;
    Board final_board;
    Turn final_turn;
    Winner actual_winner;
    TrainingEndReason end_reason;
    std::string initial_state_record;
};

using CompletionCallback = std::function<void(TrainingGame const&, int index)>;

struct NamedModel {
    EvaluationFunction model;
    std::string name;
};

struct InteractivePlayOptions {
    EvaluationFunction model;

    int samples = 1000;
    int max_parallel_samples = 256;

    std::uint32_t seed = 42;
};

struct TrainingPlayOptions {
    EvaluationFunction model1;
    EvaluationFunction model2;

    int samples = 1000;
    int max_parallel_games = 128;
    int max_parallel_samples = 16;
    int move_limit = 100;
    double temperature = 1;
    int start_game = 1;  // Starting index for output file numbering

    Turn starting_turn = {Player::Red, Turn::First};
    std::optional<PreviousPosition> starting_previous_position;
    std::string initial_state_record;

    struct StartPosition {
        Board board;
        Turn turn;
        std::optional<PreviousPosition> previous_position;
        std::string record_json;
    };
    std::vector<StartPosition> start_positions;

    CompletionCallback on_complete = [](TrainingGame const&, int) {};

    std::uint32_t seed = 42;
};

struct EvaluationPlayOptions {
    NamedModel model1;
    NamedModel model2;

    int samples = 1000;
    int max_parallel_games = 128;
    int max_parallel_samples = 16;
    int move_limit = 100;

    // Dirichlet noise mixed into the root priors. Set to 0 for a policy-only
    // measurement: with a 1-sample search there is no tree to absorb the noise,
    // so anything above 0 picks the move rather than perturbing the search.
    float noise_factor = MCTS::Options{}.noise_factor;

    std::uint32_t seed = 42;
};

struct RankingPlayOptions {
    std::vector<NamedModel> models;
    std::filesystem::path output_folder;

    int samples = 1000;
    int games_per_matchup = 10;
    int num_tournaments = 10;
    int max_parallel_games = 128;
    int max_parallel_samples = 32;
    int move_limit = 100;

    float noise_factor = MCTS::Options{}.noise_factor;

    std::uint32_t seed = 42;
};

folly::coro::Task<GameRecorder> interactive_play(Board board, InteractivePlayOptions opts);

folly::coro::Task<> training_play(Board board, int games, TrainingPlayOptions opts);

folly::coro::Task<std::vector<GameRecorder>> evaluation_play(Board board, int games,
                                                             EvaluationPlayOptions opts);

// Generates random tournaments between the models to generate ranking games for bayeselo.
folly::coro::Task<std::vector<GameRecorder>> ranking_play(Board board, RankingPlayOptions opts);

// Plays every unordered pair of models exactly once. Unlike ranking_play's
// single-elimination brackets, coverage is complete and uniform, which is what
// deterministic play (samples=1, noise_factor=0) needs: repeating a bracket
// there would replay identical games rather than gather new evidence.
folly::coro::Task<std::vector<GameRecorder>> round_robin_play(Board board, RankingPlayOptions opts);

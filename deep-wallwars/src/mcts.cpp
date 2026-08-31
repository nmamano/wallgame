#include "mcts.hpp"

#include <folly/experimental/coro/BlockingWait.h>
#include <folly/experimental/coro/Collect.h>
#include <folly/logging/xlog.h>

#include <algorithm>
#include <limits>
#include <random>
#include <ranges>

namespace views = std::ranges::views;

constexpr float kWastedInferencePenalty = 1000.0;

TreeEdge::TreeEdge(Action action, float prior)
    : action{action}, model_prior{prior}, prior{prior} {}

TreeEdge::TreeEdge(TreeEdge const& other)
    : action{other.action},
      model_prior{other.model_prior},
      prior{other.prior},
      active_samples{other.active_samples.load()},
      child{other.child.load()} {}

TreeEdge& TreeEdge::operator=(TreeEdge const& other) {
    action = other.action;
    model_prior = other.model_prior;
    prior = other.prior;
    active_samples = other.active_samples.load();
    child = other.child.load();

    return *this;
}

void TreeNode::add_sample(float weight) {
    TreeNode::Value old_val = value;
    TreeNode::Value new_val;

    do {
        new_val = {old_val.total_weight + weight, old_val.total_samples + 1};
    } while (!value.compare_exchange_weak(old_val, new_val));
}

MCTS::MCTS(EvaluationFunction evaluate, Board board)
    : MCTS{std::move(evaluate), std::move(board), {}} {}

MCTS::MCTS(EvaluationFunction evaluate, Board board, Options options)
    : m_evaluate{std::move(evaluate)},
      m_root{
          folly::coro::blockingWait(create_tree_node(
              board, options.starting_turn, options.starting_previous_position, nullptr))},
      m_opts{options},
      m_gamma_dist{options.direchlet_alpha, 1.0},
      m_twister{options.seed} {
    add_root_noise();
}

float MCTS::backup_value(float child_value, bool just_terminal, bool parent_is_second) {
    if (!parent_is_second) return child_value;
    float result = -child_value;
    return just_terminal ? result : result * kTerminalTurnDiscount;
}

int MCTS::samples_done() const {
    return m_samples_done;
}

Turn MCTS::current_turn() const {
    return m_root->turn;
}

folly::coro::Task<void> MCTS::single_sample() {
    co_await sample_rec(*m_root);
    ++m_samples_done;
}

folly::coro::Task<float> MCTS::sample(int samples) {
    m_samples_done = 0;
    if (m_opts.collect_search_diagnostics) {
        std::lock_guard lock(m_terminal_discoveries_mutex);
        m_terminal_discoveries.clear();
    }
    auto* executor = co_await folly::coro::co_current_executor;
    auto sample_tasks = views::iota(0, samples) |
                        views::transform([&](int) { return single_sample().scheduleOn(executor); });

    co_await folly::coro::collectAllWindowed(sample_tasks, m_opts.max_parallelism);

    TreeNode::Value val = m_root->value;
    co_return val.total_weight / val.total_samples;
}

TreeEdge& MCTS::get_best_edge(TreeNode& current) const {
    return *std::ranges::max_element(current.edges, {}, [&](TreeEdge const& te) {
        TreeNode::Value root_val = current.value;  // TODO: load this only once maybe?
        TreeNode* child = te.child;

        float const p_root = m_opts.puct * std::sqrt(float(root_val.total_samples));

        if (!child) {
            int const active_samples = te.active_samples;

            if (active_samples) {
                // Sampling here would be a total waste so make this expensive
                return -kWastedInferencePenalty * active_samples;
            }

            return te.prior * p_root;
        }

        TreeNode::Value child_val = child->value;

        if (current.turn.action == Turn::Second) {
            bool const child_is_terminal =
                child->board.winner(child->turn) != Winner::Undecided;
            child_val.total_weight =
                backup_value(child_val.total_weight, child_is_terminal, true);
        }

        int const active_samples = te.active_samples;
        child_val.total_weight -= m_opts.active_sample_penalty * active_samples;
        child_val.total_samples += active_samples;

        return child_val.total_weight / child_val.total_samples +
               te.prior * p_root / (1 + child_val.total_samples);
    });
}

folly::coro::Task<MCTS::SampleResult> MCTS::initialize_child(TreeNode& current, TreeEdge& edge) {
    Board next_board{current.board};
    next_board.do_action(current.turn.player, edge.action);
    std::optional<PreviousPosition> previous_position;
    if (current.turn.action == Turn::First) {
        if (auto* pawn_move = std::get_if<PawnMove>(&edge.action)) {
            previous_position = PreviousPosition{
                pawn_move->pawn,
                current.board.pawn_position(current.turn.player, pawn_move->pawn)};
        }
    }

    Turn child_turn = current.turn.next();
    TreeNode* new_node = co_await create_tree_node(std::move(next_board), child_turn,
                                                   previous_position, &current);

    float value = new_node->value.load().total_weight;
    bool just_terminal = false;
    Winner const winner = new_node->board.winner(new_node->turn);
    if (winner != Winner::Undecided) {
        value = winner == Winner::Draw ? 0.0f
            : winner == winner_from_player(new_node->turn.player) ? 1.0f : -1.0f;
        new_node->value = TreeNode::Value{value, 1};
        just_terminal = true;
    }

    TreeNode* child = nullptr;

    if (!edge.child.compare_exchange_strong(child, new_node)) {
        ++m_wasted_inferences;
        delete new_node;
    } else {
        child = new_node;
        if (just_terminal) record_terminal(winner, *child, false);
    }

    if (!just_terminal && child->edges.empty()) {
        if (child->turn.action == Turn::First) {
            child->value = TreeNode::Value{-1.0f, 1};
            co_return SampleResult{-1.0f, false};
        }
        co_return co_await sample_rec(*child);
    }
    co_return SampleResult{value, just_terminal};
}

folly::coro::Task<TreeNode*> MCTS::initialize_short_turn_child(TreeNode& current) {
    TreeNode* new_node = co_await create_tree_node(
        current.board, Turn{other_player(current.turn.player), Turn::First}, {}, &current);
    TreeNode* child = nullptr;
    if (!current.short_turn_child.compare_exchange_strong(child, new_node)) {
        ++m_wasted_inferences;
        delete new_node;
        co_return child;
    }
    co_return new_node;
}

folly::coro::Task<MCTS::SampleResult> MCTS::sample_rec(TreeNode& current) {
    Winner winner = current.board.winner(current.turn);
    bool const shortcut = winner == Winner::Undecided &&
                          m_opts.terminal_after_first_action_shortcut &&
                          current.turn.action == Turn::Second &&
                          turn_must_end_after_action(current.board, current.turn.player);
    if (shortcut) {
        winner = current.board.winner();
    }
    if (winner != Winner::Undecided) {
        record_terminal(winner, current, shortcut);
        float value = [&] {
            if (winner == Winner::Draw) {
                return 0.0;
            }

            if (winner == Winner::Red) {
                return current.turn.player == Player::Red ? 1.0 : -1.0;
            }

            return current.turn.player == Player::Blue ? 1.0 : -1.0;
        }();

        current.add_sample(value);
        co_return SampleResult{value, true};
    }

    if (current.depth - m_root->depth >= m_opts.max_depth) {
        float value = current.board.score_for(current.turn.player, current.turn);
        current.add_sample(value);
        co_return SampleResult{value, false};
    }

    // This can happen if action one leaves only an illegal undo. It is a valid short turn, not a
    // loss and not a policy action. Search the opponent's Turn::First successor directly.
    if (current.edges.empty()) {
        if (current.turn.action == Turn::First) {
            current.add_sample(-1.0f);
            // A no-legal loss is decided at this root, not by the action that reached it. A
            // preceding completed turn therefore keeps its normal distance discount.
            co_return SampleResult{-1.0f, false};
        }
        TreeNode* child = current.short_turn_child.load();
        if (child == nullptr) child = co_await initialize_short_turn_child(current);
        SampleResult result = co_await sample_rec(*child);
        result.value = backup_value(result.value, result.just_terminal, true);
        result.just_terminal = false;
        current.add_sample(result.value);
        co_return result;
    }

    TreeEdge& te = get_best_edge(current);
    ++te.active_samples;
    TreeNode* child = te.child;
    SampleResult result =
        co_await (child == nullptr ? initialize_child(current, te) : sample_rec(*child));

    if (current.turn.action == Turn::Second) {
        result.value = backup_value(result.value, result.just_terminal, true);
    }

    current.add_sample(result.value);
    result.just_terminal = false;

    --te.active_samples;
    co_return result;
}

void MCTS::record_terminal(Winner winner, TreeNode const& node, bool shortcut) {
    if (!m_opts.collect_search_diagnostics) return;
    int const depth = node.depth - m_root->depth;
    int const after_action = node.turn.action == Turn::Second ? 1 : 2;
    std::lock_guard lock(m_terminal_discoveries_mutex);
    auto const same = [&](TerminalDiscovery const& item) {
        return item.winner == winner && item.depth == depth && item.after_action == after_action &&
               item.shortcut == shortcut;
    };
    auto it = std::ranges::find_if(m_terminal_discoveries, same);
    if (it == m_terminal_discoveries.end()) {
        m_terminal_discoveries.push_back({winner, depth, after_action, 1, shortcut});
    } else {
        ++it->visits;
    }
}

void MCTS::move_root(TreeEdge const& edge) {
    m_history.push_back(root_info());

    for (TreeEdge& te2 : m_root->edges) {
        TreeNode* child = te2.child;
        if (child && child != edge.child) {
            delete_subtree(*child);
        }
    }

    TreeNode* old_root = m_root;
    m_root = edge.child;
    delete old_root;
    add_root_noise();
}

std::optional<Action> MCTS::commit_to_action() {
    if (m_root->edges.empty()) {
        XLOG(WARN, "No action available!");
        return {};
    }

    TreeEdge const& te = *std::ranges::max_element(m_root->edges, {}, [&](TreeEdge const& te) {
        return te.child ? te.child.load()->value.load().total_samples : 0;
    });

    if (!te.child) {
        XLOG(WARN, "No explored action available!");
        return {};
    }

    Action result = te.action;
    move_root(te);  // invalidates reference to te!
    return result;
}

std::optional<Action> MCTS::commit_to_action(float temperature) {
    if (temperature == 0.0) {
        return commit_to_action();
    }

    if (m_root->edges.empty()) {
        XLOG(WARN, "No action available!");
        return {};
    }

    auto const weights = std::ranges::views::transform(m_root->edges, [&](TreeEdge const& te) {
        return te.child ? std::pow(te.child.load()->value.load().total_samples, 1.0 / temperature)
                        : 0;
    });

    std::discrete_distribution<std::size_t> weight_dist(weights.begin(), weights.end());
    TreeEdge const& te = m_root->edges[weight_dist(m_twister)];

    if (!te.child) {
        XLOG(WARN, "No explored action available!");
        return {};
    }

    Action result = te.action;
    move_root(te);  // invalidates reference to te!
    return result;
}

folly::coro::Task<std::optional<Move>> MCTS::sample_and_commit_to_move(int iterations) {
    co_await sample(iterations);

    // Read before committing: commit_to_action moves the root into the child, and with it the turn.
    Player const mover = current_turn().player;
    auto action_1 = commit_to_action();
    if (!action_1) {
        co_return {};
    }

    // Whether the MOVER captured, not whether the position is decided. A capture is judged when the
    // turn ENDS, so this says "won unless we walk the cat off again" and a wall keeps it. The mirror
    // case - our own mouse stepping onto the enemy cat - decides nothing and must NOT stop the turn,
    // or the mouse is stranded on the cat and the game is handed over (board task 8911a6d5).
    bool const terminal_after_first = current_board().variant() == Variant::AnimalCycle
        ? current_board().winner(current_turn()) != Winner::Undecided
        : current_board().reached_goal(mover);
    if (terminal_after_first) {
        auto legal_walls = current_board().legal_walls();

        if (legal_walls.empty()) {
            co_return {};
        }

        co_return Move{*action_1, legal_walls[0]};
    }

    co_await sample(iterations);
    auto action_2 = commit_to_action();
    if (!action_2) {
        co_return {};
    }

    co_return Move{*action_1, *action_2};
}

void MCTS::force_action(Action const& action) {
    auto const te_it = std::ranges::find_if(
        m_root->edges, [&](TreeEdge const& te) { return action == te.action; });

    if (te_it == m_root->edges.end()) {
        throw std::runtime_error("Could not find action - not legal?");
    }

    if (!te_it->child) {
        Board board = m_root->board;
        std::optional<PreviousPosition> previous_position;
        if (m_root->turn.action == Turn::First) {
            if (auto* pawn_move = std::get_if<PawnMove>(&action)) {
                previous_position = PreviousPosition{
                    pawn_move->pawn,
                    board.pawn_position(m_root->turn.player, pawn_move->pawn)};
            }
        }
        board.do_action(m_root->turn.player, action);
        te_it->child = folly::coro::blockingWait(
            create_tree_node(std::move(board), m_root->turn.next(), previous_position, m_root));
    }

    move_root(*te_it);
}

void MCTS::force_move(Move const& move) {
    force_action(move.first);

    // Reading the turn is what makes this safe to replay someone else's move through. Mid-turn the
    // game cannot be over (see Board::winner(Turn)), so a two-action move always applies BOTH
    // actions, even when the first one put a cat on a mouse - the mover is free to walk it off
    // again, and skipping the second action would leave this tree a turn behind the real game.
    if (m_root->board.winner(m_root->turn) == Winner::Undecided) {
        force_action(move.second);
    }
}

void MCTS::reset_to_position(Board board, Turn turn) {
    delete_subtree(*m_root);
    m_history.clear();
    m_root = folly::coro::blockingWait(create_tree_node(std::move(board), turn, {}, nullptr));
    add_root_noise();
}

// Highest-prior action among `edges`, or nullopt if there are none.
//
// `TreeEdge::prior` is the policy head's probability for that action and it is filled in for EVERY
// legal action the moment a node is created, so this is well defined before any sample has descended
// through the node. That is what lets the peek functions below answer at very low sample counts
// instead of reporting that no move exists (board task 945fe1ef).
static std::optional<Action> max_prior_action(std::vector<TreeEdge> const& edges) {
    if (edges.empty()) {
        return {};
    }

    return std::ranges::max_element(edges, {}, [](TreeEdge const& te) { return te.prior; })->action;
}

std::optional<Action> MCTS::peek_best_action() const {
    if (m_root->edges.empty()) {
        return {};
    }

    // Find the edge with the most samples (same logic as commit_to_action)
    TreeEdge const& te = *std::ranges::max_element(m_root->edges, {}, [&](TreeEdge const& te) {
        return te.child ? te.child.load()->value.load().total_samples : 0;
    });

    if (!te.child) {
        // No sample has descended through any root edge yet, so there is no visit evidence to rank
        // by - but the policy's priors are already here, so the network's own preferred action is
        // available for free. Note that `commit_to_action` deliberately does NOT do this: it moves
        // the root into the chosen edge and therefore needs a real child.
        return max_prior_action(m_root->edges);
    }

    return te.action;
}

TreeNode* MCTS::child_after(Action const& action) const {
    auto const edge = std::ranges::find_if(
        m_root->edges, [&](TreeEdge const& te) { return te.action == action; });
    if (edge == m_root->edges.end()) {
        return nullptr;
    }
    return edge->child.load();
}

bool MCTS::turn_is_over_after(TreeNode const& after_first) const {
    // One shared predicate, defined in gamestate.hpp. `after_first.turn` is Turn::Second for the
    // mover, which is the Turn its Animal Cycle half asks about, so this is the same question this
    // function has always asked - just no longer a private copy of it.
    //
    // `peek_best_move` responds differently from the other two callers, and that is a difference of
    // RESPONSE and not of question: it promises a complete two-action Move, so it pads an
    // already-decided turn with a wall rather than returning one action.
    return turn_must_end_after_action(after_first.board, m_root->turn.player);
}

std::optional<Action> MCTS::peek_best_second_action(Action const& first) const {
    TreeNode* child = child_after(first);
    if (!child) {
        return {};
    }

    // An empty edge list here is a genuinely action-less position, which happens when our only
    // possible second action would be to undo the first one - see the comment in sample_rec. It is
    // a real state of the board and not a failure: the rules let the turn stop after one action, so
    // the caller answers with the first action alone.
    if (child->edges.empty()) {
        return {};
    }

    TreeEdge const& second_edge = *std::ranges::max_element(
        child->edges, {}, [&](TreeEdge const& te) {
            return te.child ? te.child.load()->value.load().total_samples : 0;
        });

    if (!second_edge.child) {
        // No second action below `first` has been expanded, so there is no visit evidence at this
        // depth. That is the ordinary state below roughly a hundred samples: the root's child only
        // gets a second visit once the search returns to it, and until then EVERY grandchild edge is
        // still null - which is why the whole move used to be reported as unavailable and the engine
        // answered "No legal move available" at low sample counts (board task 945fe1ef).
        //
        // Fall back to the policy head for the second action only. This branch is reached only when
        // nothing below `child` is expanded at all: any expanded edge would win the max_element above
        // on visit count, so once there is any visit evidence the search's choice stands.
        return max_prior_action(child->edges);
    }

    return second_edge.action;
}

std::optional<NodeInfo> MCTS::child_info(Action const& first) const {
    TreeNode* child = child_after(first);
    if (!child) {
        return {};
    }
    TreeNode::Value const value = child->value;
    NodeInfo result{
        child->board,
        child->turn,
        value.total_samples == 0 ? 0.0f : value.total_weight / value.total_samples,
        value.total_samples,
        {},
    };
    result.model_value = child->model_value;
    result.edges.reserve(child->edges.size());
    for (TreeEdge const& edge : child->edges) {
        TreeNode* grandchild = edge.child;
        int samples = 0;
        float q_value = 0.0f;
        if (grandchild) {
            TreeNode::Value const grandchild_value = grandchild->value.load();
            samples = grandchild_value.total_samples;
            if (samples > 0) {
                q_value = grandchild_value.total_weight / samples;
            }
        }
        result.edges.emplace_back(edge.action, samples, q_value, edge.prior, edge.model_prior);
    }
    return result;
}

std::optional<Move> MCTS::peek_best_move() const {
    // Get the best first action
    auto action1 = peek_best_action();
    if (!action1) {
        return {};
    }

    TreeNode* child = child_after(*action1);
    if (!child) {
        return {};
    }

    if (turn_is_over_after(*child)) {
        // First action decided the game - which may have decided it for the OPPONENT, so this is
        // not "we won". Either way nothing real can follow, and this function owes its callers a
        // complete two-action Move, so it returns an arbitrary legal wall that leaves the pawn
        // where it is.
        auto legal_walls = child->board.legal_walls();
        if (legal_walls.empty()) {
            return {};
        }
        return Move{*action1, legal_walls[0]};
    }

    auto action2 = peek_best_second_action(*action1);
    if (!action2) {
        return {};
    }

    return Move{*action1, *action2};
}

std::vector<PvStep> MCTS::principal_variation(int max_actions, float delta,
                                              int min_visits) const {
    std::vector<PvStep> pv;
    TreeNode const* node = m_root;

    while (static_cast<int>(pv.size()) < max_actions) {
        if (node == nullptr || node->edges.empty()) {
            break;
        }
        if (node->board.winner(node->turn) != Winner::Undecided) {
            break;
        }

        int const node_visits = node->value.load().total_samples;

        // A node's value is stored from ITS OWN turn.player's perspective, and the sign
        // flips as the turn passes to the opponent - the same rule sample_rec applies
        // when it propagates values back up. So reading a child's value as "how good is
        // this action for the player choosing it" needs the flip on second actions.
        bool const flip = node->turn.action == Turn::Second;
        auto action_q = [&](TreeNode const* child) {
            TreeNode::Value const val = child->value.load();
            if (val.total_samples == 0) {
                return 0.0f;
            }
            float const q = val.total_weight / val.total_samples;
            if (!flip) return q;
            bool const child_is_terminal =
                child->board.winner(child->turn) != Winner::Undecided;
            return backup_value(q, child_is_terminal, true);
        };

        // Ignore barely-touched edges. MCTS deliberately starves bad actions, so an edge
        // with a handful of visits has a Q that is noise, and counting it would make a
        // forced position look like a wide-open one (or the reverse).
        int const visit_floor = std::max(1, node_visits / 100);

        TreeEdge const* best = nullptr;
        int best_visits = -1;
        int considered = 0;
        for (TreeEdge const& edge : node->edges) {
            TreeNode const* child = edge.child.load();
            if (child == nullptr) {
                continue;
            }
            int const visits = child->value.load().total_samples;
            if (visits >= visit_floor) {
                ++considered;
            }
            if (visits > best_visits) {
                best_visits = visits;
                best = &edge;
            }
        }

        if (best == nullptr || best->child.load() == nullptr) {
            break;
        }
        TreeNode const* best_child = best->child.load();
        if (best_visits < min_visits) {
            break;  // the tree below here is too thin to say anything about the line
        }

        float const best_q = action_q(best_child);
        float runner_up_q = -std::numeric_limits<float>::infinity();
        int near_best = 0;
        for (TreeEdge const& edge : node->edges) {
            TreeNode const* child = edge.child.load();
            if (child == nullptr || child->value.load().total_samples < visit_floor) {
                continue;
            }
            float const q = action_q(child);
            // ">= best - delta" rather than a two-sided band: an action scoring ABOVE the
            // most-visited one is also a live alternative, and excluding it would report
            // a position as forced when the solver actually has a choice.
            if (q >= best_q - delta) {
                ++near_best;
            }
            if (&edge != best && q > runner_up_q) {
                runner_up_q = q;
            }
        }

        float const gap =
            runner_up_q == -std::numeric_limits<float>::infinity() ? 0.0f : best_q - runner_up_q;

        pv.push_back(PvStep{
            .action = best->action,
            .player = node->turn.player,
            .second_action = node->turn.action == Turn::Second,
            .node_visits = node_visits,
            .child_visits = best_visits,
            .q_value = best_q,
            .gap = gap,
            .near_best = std::max(1, near_best),
            .considered = std::max(1, considered),
        });

        node = best_child;
    }

    return pv;
}

void MCTS::add_root_noise() {
    float total = 0.0;

    std::vector<float> samples(m_root->edges.size());

    for (float& s : samples) {
        total += (s = m_gamma_dist(m_twister));
    }

    for (std::size_t i = 0; i < samples.size(); ++i) {
        m_root->edges[i].prior = (1 - m_opts.noise_factor) * m_root->edges[i].prior +
                                 m_opts.noise_factor * samples[i] / total;
    }
}

folly::coro::Task<TreeNode*> MCTS::create_tree_node(
    Board board,
    Turn turn,
    std::optional<PreviousPosition> previous_position,
    TreeNode* parent) {
    Evaluation eval = co_await m_evaluate(board, turn, previous_position);
    TreeNode* result = new TreeNode{parent,
                                    std::move(board),
                                    turn,
                                    parent ? parent->depth + 1 : 0,
                                    eval.value,
                                    TreeNode::Value{eval.value, 1},
                                    std::move(eval.edges)};

    co_return result;
}

MCTS::~MCTS() {
    delete_subtree(*m_root);
}

void MCTS::delete_subtree(TreeNode& tn) {
    std::vector<TreeNode*> delete_stack{&tn};

    while (!delete_stack.empty()) {
        TreeNode* tn_top = delete_stack.back();
        delete_stack.pop_back();

        for (TreeEdge const& te : tn_top->edges) {
            if (te.child != nullptr) {
                delete_stack.push_back(te.child);
            }
        }
        if (tn_top->short_turn_child != nullptr) {
            delete_stack.push_back(tn_top->short_turn_child);
        }

        delete tn_top;
    }
}

MCTS::RootDisposition MCTS::root_disposition() const {
    if (m_root->board.winner(m_root->turn) != Winner::Undecided) {
        return RootDisposition::Terminal;
    }
    if (!m_root->edges.empty()) return RootDisposition::Expandable;
    return m_root->turn.action == Turn::First ? RootDisposition::NoLegalFirst
                                              : RootDisposition::ShortTurnSecond;
}

bool MCTS::advance_short_turn() {
    if (root_disposition() != RootDisposition::ShortTurnSecond) return false;
    TreeNode* child = m_root->short_turn_child.load();
    if (child == nullptr) {
        child = folly::coro::blockingWait(initialize_short_turn_child(*m_root));
    }
    TreeNode* old_root = m_root;
    m_root = child;
    old_root->short_turn_child = nullptr;
    delete_subtree(*old_root);
    m_root->parent = nullptr;
    add_root_noise();
    return true;
}

Board const& MCTS::current_board() const {
    return m_root->board;
}

float MCTS::root_value() const {
    TreeNode::Value val = m_root->value;
    if (val.total_samples == 0) {
        return 0.0f;
    }
    return val.total_weight / val.total_samples;
}

int MCTS::root_samples() const {
    return m_root->value.load().total_samples;
}

NodeInfo MCTS::root_info() const {
    TreeNode::Value const val = m_root->value;
    NodeInfo result{
        m_root->board, m_root->turn, val.total_weight / val.total_samples, val.total_samples, {}};
    result.edges.reserve(m_root->edges.size());
    result.model_value = m_root->model_value;

    for (TreeEdge const& edge : m_root->edges) {
        TreeNode* child = edge.child;
        int num_samples = 0;
        float q_value = 0.0f;
        if (child) {
            TreeNode::Value const child_val = child->value.load();
            num_samples = child_val.total_samples;
            if (num_samples > 0) {
                q_value = child_val.total_weight / child_val.total_samples;
            }
        }
        result.edges.emplace_back(edge.action, num_samples, q_value, edge.prior,
                                  edge.model_prior);
    }

    return result;
}

std::vector<NodeInfo> const& MCTS::history() const {
    return m_history;
}

int MCTS::wasted_inferences() const {
    return m_wasted_inferences;
}

std::vector<TerminalDiscovery> MCTS::terminal_discoveries() const {
    std::lock_guard lock(m_terminal_discoveries_mutex);
    return m_terminal_discoveries;
}

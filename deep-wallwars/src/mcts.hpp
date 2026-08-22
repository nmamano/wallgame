#pragma once

#include <folly/experimental/coro/Task.h>
#include <folly/futures/Future.h>

#include <atomic>
#include <random>

#include "gamestate.hpp"

struct TreeNode;

struct TreeEdge {
    Action action;
    float prior;
    std::atomic<int> active_samples = 0;
    std::atomic<TreeNode*> child = nullptr;

    TreeEdge() = default;
    TreeEdge(Action action, float prior);

    TreeEdge(TreeEdge const& other);
    TreeEdge& operator=(TreeEdge const& other);
};

struct TreeNode {
    struct Value {
        float total_weight;
        int total_samples;
    };

    TreeNode* parent;
    Board board;
    Turn turn;
    int depth;
    std::atomic<Value> value;
    std::vector<TreeEdge> edges;

    void add_sample(float weight);
};

struct EdgeInfo {
    Action action;
    int num_samples;
    float q_value;  // child node value (total_weight / total_samples), 0 if unvisited
    float prior;    // NN prior probability for this edge
};

struct NodeInfo {
    Board board;
    Turn turn;
    float q_value;
    int num_samples;

    std::vector<EdgeInfo> edges;
};

// One action along the principal variation, together with the statistics that say how
// CONSTRAINED that choice was. `near_best` is the forcing measure: when the side to move
// has exactly one action within delta of the best, the line is forced there, and a human
// solver can VERIFY a concrete sequence instead of having to trust a positional
// judgement. That is decision D2 in info/puzzle-generation.md, and skipping it is why the
// first batch of generated puzzles was unsolvable by a human.
struct PvStep {
    Action action;
    Player player;       // who is acting at this step
    bool second_action;  // false = first action of the turn, true = second
    int node_visits;     // visits at the node where this choice was made
    int child_visits;    // visits below the chosen action
    float q_value;       // value after the action, from `player`'s perspective
    float gap;           // best q minus the runner-up's q, same perspective
    int near_best;       // actions within delta of the best (always >= 1)
    int considered;      // actions visited enough to be judged at all
};

struct Evaluation {
    float value;
    std::vector<TreeEdge> edges;
};

// Coroutine that takes the current board and player turn and "evaluates" it, either by some
// heuristic or ML model. The last argument is the previous position of the current player, which is
// needed because we may not return to that position in the same move.
using EvaluationFunction =
    std::function<folly::coro::Task<Evaluation>(Board const&, Turn,
                                                std::optional<PreviousPosition>)>;

class MCTS {
public:
    struct Options {
        float puct = 2.0;
        int max_depth = 50;
        int max_parallelism = 4;
        float direchlet_alpha = 0.3;
        float noise_factor = 0.25;
        float active_sample_penalty = 1.0;
        Turn starting_turn = {Player::Red, Turn::First};
        std::optional<PreviousPosition> starting_previous_position;
        std::uint32_t seed = 42;
    };

    MCTS(EvaluationFunction evaluate, Board board);
    MCTS(EvaluationFunction evaluate, Board board, Options opts);

    Board const& current_board() const;
    Turn current_turn() const;
    float root_value() const;
    int root_samples() const;
    NodeInfo root_info() const;
    std::vector<NodeInfo> const& history() const;
    int wasted_inferences() const;

    folly::coro::Task<float> sample(int iterations);

    // Thread safe, can be called to see sample progress.
    int samples_done() const;

    // Selects the best action from the perspective of the current player and commits to it.
    // In rare cases there may be no valid action at all (either because the EvaluationFunction is
    // arbitrarily restricting the set of possible actions or because our previous action ran us
    // into a dead-end).
    std::optional<Action> commit_to_action();
    std::optional<Action> commit_to_action(float temperature);

    // Selects the move (two actions) from the perspective of the current player and commits to it.
    // If the first action wins the game, the second action will place a wall arbitrarily.
    folly::coro::Task<std::optional<Move>> sample_and_commit_to_move(int iterations);

    void force_action(Action const& action);
    void force_move(Move const& move);

    // Reset the tree to a new board position and turn.
    // Destroys the existing tree and creates a fresh root node.
    // Used when the tree needs to skip ahead (e.g., partial-turn moves).
    void reset_to_position(Board board, Turn turn);

    // Returns the best action without modifying the tree.
    // Use this when you need to know the best move but don't want to commit to it yet.
    // Ranks by visit count, and when NOTHING has been expanded yet it falls back to the highest
    // policy prior, so this answers even with zero samples. Returns nullopt only for a position with
    // no legal action at all.
    std::optional<Action> peek_best_action() const;

    // Returns the best move (two actions) without modifying the tree.
    // If the first action wins the game, the second action will be an arbitrary legal wall.
    // Each action falls back to the highest policy prior when nothing below it has been expanded, so
    // a single sample is enough for a complete move. Returns nullopt with ZERO samples, because
    // without the root's child there is no second position whose policy could be read, and creating
    // one would mutate the tree; also nullopt when a position has no legal action at all.
    std::optional<Move> peek_best_move() const;

    // The best SECOND action of a turn whose first action is already chosen, without modifying the
    // tree. Ranks by visit count and falls back to the highest policy prior below `first` when
    // nothing there has been expanded yet, exactly as `peek_best_move` does.
    //
    // Returns nullopt when the position after `first` has no legal action - most often because the
    // only remaining action would undo `first`. That is a REAL STATE and not a failure: the rules
    // allow a turn of one action, so the caller answers with `first` alone. Ask this instead of
    // `peek_best_move` wherever a short turn is an acceptable answer; `peek_best_move` exists for
    // the callers that need a complete two-action `Move` to hand to the tree.
    std::optional<Action> peek_best_second_action(Action const& first) const;

    // Read-only diagnostic view of the already-expanded child below one root
    // action. Used only by the offline checkpoint-to-serving parity gate.
    std::optional<NodeInfo> child_info(Action const& first) const;

    // Walks the most-visited path down from the root, which is the search's principal
    // variation - the line it expects both sides to play. Does not modify the tree; the
    // line is already there, so this costs nothing beyond the walk.
    //
    // Stops at `max_actions`, at a decided position, or as soon as the subtree drops
    // below `min_visits` samples, because past that point the tree is too thin for
    // "the opponent has only one reply" to mean anything. A SHORT principal variation is
    // therefore itself a signal - it says the search never committed to a single line.
    // `delta` is the Q-closeness used for the per-step near_best/gap statistics.
    std::vector<PvStep> principal_variation(int max_actions, float delta, int min_visits) const;

    ~MCTS();

private:
    EvaluationFunction m_evaluate;
    TreeNode* m_root;
    Options m_opts;
    std::gamma_distribution<float> m_gamma_dist;
    std::mt19937_64 m_twister;
    std::atomic<int> m_wasted_inferences = 0;
    std::atomic<int> m_samples_done = 0;
    std::vector<NodeInfo> m_history;

    void add_root_noise();
    folly::coro::Task<void> single_sample();
    TreeEdge& get_best_edge(TreeNode& current) const;
    folly::coro::Task<float> initialize_child(TreeNode& current, TreeEdge& edge);
    folly::coro::Task<float> sample_rec(TreeNode& current);
    void delete_subtree(TreeNode& node);
    void move_root(TreeEdge const& edge);

    // The expanded node one action below the root, or nullptr when that edge is missing or has not
    // been expanded yet.
    TreeNode* child_after(Action const& action) const;
    // Whether the game is already decided in `after_first`, so no genuine second action can
    // follow. Not the same as "the mover won" - see `turn_must_end_after_action`.
    bool turn_is_over_after(TreeNode const& after_first) const;

    folly::coro::Task<TreeNode*> create_tree_node(Board board, Turn turn,
                                                  std::optional<PreviousPosition> previous_position,
                                                  TreeNode* parent);
};

#include "gamestate.hpp"

#include <catch2/catch_approx.hpp>
#include <catch2/catch_get_random_seed.hpp>
#include <catch2/catch_test_macros.hpp>
#include <random>

TEST_CASE("Legal walls", "[Game State]") {
    Board tiny{2, 2};

    REQUIRE(tiny.legal_walls().size() == 4);
    tiny.place_wall(Player::Blue, {{0, 0}, Direction::Right});
    REQUIRE(tiny.legal_walls().size() == 0);
}

TEST_CASE("Empty board", "[Game State]") {
    Board board{3, 3};

    REQUIRE(board.position(Player::Red) == Cell{0, 0});
    REQUIRE(board.position(Player::Blue) == Cell{2, 0});

    REQUIRE(board.goal(Player::Red) == Cell{2, 2});
    REQUIRE(board.goal(Player::Blue) == Cell{0, 2});

    REQUIRE(board.legal_directions(Player::Red).size() == 2);
    REQUIRE(board.legal_directions(Player::Blue).size() == 2);

    REQUIRE(board.legal_walls().size() == 12);

    REQUIRE(board.legal_actions(Player::Red).size() == 14);
    REQUIRE(board.legal_actions(Player::Blue).size() == 14);

    REQUIRE(board.winner() == Winner::Undecided);
}

TEST_CASE("Big board", "[Game State]") {
    Board board{8, 8};

    board.place_wall(Player::Red, {{1, 3}, Direction::Right});
    board.place_wall(Player::Red, {{4, 4}, Direction::Right});

    board.take_step(Player::Blue, Direction::Down);
    board.take_step(Player::Blue, Direction::Down);

    board.place_wall(Player::Red, {{0, 3}, Direction::Down});
    board.place_wall(Player::Red, {{0, 7}, Direction::Right});

    board.take_step(Player::Blue, Direction::Down);
    board.take_step(Player::Blue, Direction::Down);

    board.place_wall(Player::Red, {{1, 4}, Direction::Down});
    board.place_wall(Player::Red, {{4, 3}, Direction::Right});

    board.take_step(Player::Blue, Direction::Left);
    board.take_step(Player::Blue, Direction::Down);

    board.take_step(Player::Red, Direction::Right);
    board.take_step(Player::Red, Direction::Right);

    board.place_wall(Player::Blue, {{2, 0}, Direction::Right});
    board.place_wall(Player::Blue, {{2, 0}, Direction::Down});

    REQUIRE(board.legal_directions(Player::Red).size() == 1);
}

TEST_CASE("Big board 2", "[Game State]") {
    Board board{8, 8};

    board.do_action(Player::Red, PawnMove{Pawn::Cat, Direction::Right});
    board.do_action(Player::Red, PawnMove{Pawn::Cat, Direction::Down});

    board.do_action(Player::Blue, Wall{{2, 0}, Direction::Down});
    board.do_action(Player::Blue, Wall{{4, 2}, Direction::Down});

    board.do_action(Player::Red, PawnMove{Pawn::Cat, Direction::Right});
    board.do_action(Player::Red, Wall{{1, 1}, Direction::Right});

    board.do_action(Player::Blue, Wall{{2, 0}, Direction::Right});
    board.do_action(Player::Blue, Wall{{1, 3}, Direction::Right});

    board.do_action(Player::Red, PawnMove{Pawn::Cat, Direction::Right});
    board.do_action(Player::Red, Wall{{2, 1}, Direction::Right});

    board.do_action(Player::Blue, Wall{{3, 1}, Direction::Right});
    board.do_action(Player::Blue, Wall{{3, 1}, Direction::Down});

    board.do_action(Player::Red, Wall{{1, 7}, Direction::Right});
    board.do_action(Player::Red, Wall{{1, 6}, Direction::Right});
}

TEST_CASE("Standard variant basics", "[Game State]") {
    Board board{3, 3, Variant::Standard};

    REQUIRE(board.variant() == Variant::Standard);
    REQUIRE(board.allows_mouse_moves());
    REQUIRE(board.move_prior_size() == 8);

    REQUIRE(board.goal(Player::Red) == board.mouse(Player::Blue));
    REQUIRE(board.goal(Player::Blue) == board.mouse(Player::Red));

    REQUIRE(board.legal_directions(Player::Red, Pawn::Mouse).size() == 2);

    auto const actions = board.legal_actions(Player::Red);
    CHECK(actions.size() ==
          board.legal_walls().size() + board.legal_directions(Player::Red, Pawn::Cat).size() +
              board.legal_directions(Player::Red, Pawn::Mouse).size());

    board.take_step(Player::Blue, Pawn::Mouse, Direction::Left);
    CHECK(board.goal(Player::Red) == Cell{1, 2});
}

TEST_CASE("Standard variant mouse capture ends game", "[Game State]") {
    Board board{3, 3, {0, 0}, {1, 0}, {2, 0}, {2, 2}, Variant::Standard};

    board.take_step(Player::Red, Pawn::Mouse, Direction::Right);

    REQUIRE(board.mouse(Player::Red) == Cell{2, 0});
    REQUIRE(board.winner() == Winner::Blue);
}

TEST_CASE("Advance to win", "[Game State]") {
    Board board{3, 3, {0, 0}, {0, 2}, {2, 0}, {2, 2}};

    board.take_step(Player::Red, Direction::Right);
    REQUIRE(board.winner() == Winner::Undecided);
    board.take_step(Player::Red, Direction::Down);
    REQUIRE(board.winner() == Winner::Undecided);
    board.take_step(Player::Red, Direction::Down);
    REQUIRE(board.winner() == Winner::Undecided);
    board.take_step(Player::Red, Direction::Right);
    REQUIRE(board.position(Player::Red) == board.goal(Player::Red));
    REQUIRE(board.winner() == Winner::Red);
}

TEST_CASE("Block walls", "[Game State]") {
    Board board{3, 3, {0, 0}, {0, 2}, {2, 0}, {2, 2}};
    board.place_wall(Player::Blue, {{0, 0}, Direction::Right});
    REQUIRE(board.is_blocked({{0, 0}, Direction::Right}));
    REQUIRE(board.legal_directions(Player::Red).size() == 1);
}

TEST_CASE("Distance", "[Game State]") {
    Board board{3, 3, {0, 0}, {0, 2}, {2, 0}, {2, 2}};
    REQUIRE(board.distance({0, 0}, {2, 2}) == 4);
    REQUIRE(board.distance({2, 1}, {2, 2}) == 1);
}

TEST_CASE("Can't disconnect players from goals", "[Game State]") {
    Board board{3, 3};
    board.place_wall(Player::Blue, {{0, 0}, Direction::Right});
    REQUIRE(board.legal_walls().size() == 10);
}

TEST_CASE("Removing random legal walls doesn't disconnect players", "[Game State]") {
    std::mt19937_64 twister{Catch::getSeed()};

    for (int i = 0; i < 10; ++i) {
        Board board{5, 5};
        auto legal_walls = board.legal_walls();

        while (!legal_walls.empty()) {
            std::uniform_int_distribution<std::size_t> dist(0, legal_walls.size() - 1);
            board.place_wall(Player::Red, legal_walls[dist(twister)]);
            legal_walls = board.legal_walls();
        }

        CHECK(board.distance(board.position(Player::Red), board.goal(Player::Red)) != -1);
        CHECK(board.distance(board.position(Player::Blue), board.goal(Player::Blue)) != -1);
    }
}

TEST_CASE("Fill relative distances", "[Game State]") {
    Board board{3, 3};

    std::vector<float> dists(9, 1.0f);
    board.fill_relative_distances({0, 0}, dists);

    CHECK(dists[0] == 0.0f);
    CHECK(dists[1] == Catch::Approx(0.111111f));
    CHECK(dists[3] == Catch::Approx(0.111111f));
    CHECK(dists[4] == Catch::Approx(0.222222f));
    CHECK(dists[8] == Catch::Approx(0.444444f));

    board.place_wall(Player::Red, {{0, 0}, Direction::Right});
    board.place_wall(Player::Red, {{0, 0}, Direction::Down});
    board.fill_relative_distances({0, 0}, dists);

    CHECK(dists[0] == 0.0f);
    CHECK(dists[1] == 1.0f);
    CHECK(dists[3] == 1.0f);

    std::vector<std::array<bool, 4>> blocked_dirs = board.blocked_directions();
    std::vector<std::pair<Cell, int>> queue_vec;
    std::fill(dists.begin(), dists.end(), 1.0f);

    board.fill_relative_distances({0, 0}, dists, blocked_dirs, queue_vec);
    CHECK(dists[0] == 0.0f);
    CHECK(dists[1] == 1.0f);
    CHECK(dists[3] == 1.0f);
}

TEST_CASE("Fill relative distances matches distance", "[Game State]") {
    Board board{5, 5};
    std::mt19937_64 twister{Catch::getSeed()};

    for (int i = 0; i < 10; ++i) {
        auto legal_walls = board.legal_walls();
        if (legal_walls.empty())
            break;

        std::uniform_int_distribution<std::size_t> dist(0, legal_walls.size() - 1);
        board.place_wall(Player::Red, legal_walls[dist(twister)]);
    }

    for (int start_row = 0; start_row < 5; start_row += 2) {
        for (int start_col = 0; start_col < 5; start_col += 2) {
            Cell start{start_col, start_row};
            std::vector<float> dists(25, 1.0f);
            board.fill_relative_distances(start, dists);

            for (int row = 0; row < 5; ++row) {
                for (int col = 0; col < 5; ++col) {
                    Cell target{col, row};
                    int actual_dist = board.distance(start, target);
                    if (actual_dist != -1) {
                        float expected = static_cast<float>(actual_dist) / 25.0f;
                        CHECK(dists[board.index_from_cell(target)] == Catch::Approx(expected));
                    } else {
                        CHECK(dists[board.index_from_cell(target)] == 1.0f);
                    }
                }
            }
        }
    }
}

// A capture counts only when a turn ENDS, so a pawn may step onto the cell where it would be taken
// and out the other side within a single turn. The engine used to judge the bare position after
// every individual action, which ended games the TypeScript server was still playing and froze the
// bot session mid-turn (board task 8911a6d5).
TEST_CASE("A mouse may walk past a cat mid-turn", "[Game State]") {
    // Red's mouse with Blue's cat one step to its right, Red to move.
    Board board{5, 5, Cell{0, 0}, Cell{2, 2}, Cell{3, 2}, Cell{4, 4}, Variant::Standard};

    REQUIRE(board.winner() == Winner::Undecided);

    board.do_action(Player::Red, PawnMove{Pawn::Mouse, Direction::Right});

    // The bare position reads as a capture, and if the turn ended here it would be one...
    CHECK(board.reached_goal(Player::Blue));
    CHECK(board.winner() == Winner::Blue);
    CHECK(board.winner(Turn{Player::Blue, Turn::First}) == Winner::Blue);

    // ...but Red still owes an action, so nothing is decided yet.
    CHECK(board.winner(Turn{Player::Red, Turn::Second}) == Winner::Undecided);

    board.do_action(Player::Red, PawnMove{Pawn::Mouse, Direction::Right});

    CHECK(board.mouse(Player::Red) == Cell{4, 2});
    CHECK(board.winner() == Winner::Undecided);
    CHECK(board.winner(Turn{Player::Blue, Turn::First}) == Winner::Undecided);
}

// The same rule in the other direction, which is the half that is easy to forget: a cat routing
// toward its goal may pass straight THROUGH the enemy mouse's cell.
TEST_CASE("A cat may walk over a mouse mid-turn", "[Game State]") {
    // Red's cat one step left of Blue's mouse. Blue's cat is far from Red's mouse, so the
    // one-move-rule draw does not apply and the capture would be a clean Red win.
    Board board{5, 5, Cell{2, 2}, Cell{0, 0}, Cell{4, 4}, Cell{3, 2}, Variant::Standard};

    REQUIRE(board.winner() == Winner::Undecided);

    board.do_action(Player::Red, PawnMove{Pawn::Cat, Direction::Right});

    CHECK(board.reached_goal(Player::Red));
    CHECK(board.winner() == Winner::Red);
    CHECK(board.winner(Turn{Player::Blue, Turn::First}) == Winner::Red);
    CHECK(board.winner(Turn{Player::Red, Turn::Second}) == Winner::Undecided);

    board.do_action(Player::Red, PawnMove{Pawn::Cat, Direction::Right});

    CHECK(board.position(Player::Red) == Cell{4, 2});
    CHECK(board.winner() == Winner::Undecided);
}

TEST_CASE("score_for does not read a mid-turn walk-past as a loss", "[Game State]") {
    // The position from the middle of Red's turn in the first case above: Red's mouse standing on
    // Blue's cat, with Red still holding an action.
    Board board{5, 5, Cell{0, 0}, Cell{3, 2}, Cell{3, 2}, Cell{4, 4}, Variant::Standard};

    // At a turn boundary this is a real capture and Red has lost outright.
    CHECK(board.score_for(Player::Red) == -1.0);
    CHECK(board.score_for(Player::Red, Turn{Player::Blue, Turn::First}) == -1.0);

    // Mid-turn it is not. Red's cat is 8 steps from its goal, and Blue's cat counts as ONE step from
    // Red's mouse - which is where it will be the moment the mouse steps aside - so the heuristic is
    // -1 + 1/8. Scoring a certain loss here would make the search shun a walk-past it is allowed to
    // make; scoring a flat 0 would make a lost position look level.
    double const mid_turn = board.score_for(Player::Red, Turn{Player::Red, Turn::Second});
    CHECK(mid_turn == Catch::Approx(-0.875));
    CHECK(mid_turn > -1.0);
    CHECK(mid_turn < 0.0);
}

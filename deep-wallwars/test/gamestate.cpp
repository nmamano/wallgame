#include "gamestate.hpp"

#include <catch2/catch_approx.hpp>
#include <catch2/catch_get_random_seed.hpp>
#include <catch2/catch_test_macros.hpp>
#include <random>

namespace {
Board standard_board(int columns, int rows, Cell red_cat, Cell red_mouse, Cell blue_cat,
                     Cell blue_mouse) {
    return Board{columns,
                 rows,
                 Variant::Standard,
                 {{Player::Red, Pawn::Cat, red_cat},
                  {Player::Red, Pawn::Mouse, red_mouse},
                  {Player::Blue, Pawn::Cat, blue_cat},
                  {Player::Blue, Pawn::Mouse, blue_mouse}}};
}
}  // namespace

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
    REQUIRE(board.home(Player::Red) == Cell{2, 2});
    REQUIRE(board.home(Player::Blue) == Cell{0, 2});
    REQUIRE_FALSE(board.has_pawn(Player::Red, Pawn::Mouse));
    REQUIRE_FALSE(board.has_pawn(Player::Blue, Pawn::Mouse));
    REQUIRE_FALSE(board.pawn_is_movable(Pawn::Home));

    REQUIRE(board.legal_directions(Player::Red).size() == 2);
    REQUIRE(board.legal_directions(Player::Blue).size() == 2);

    REQUIRE(board.legal_walls().size() == 12);

    REQUIRE(board.legal_actions(Player::Red).size() == 14);
    REQUIRE(board.legal_actions(Player::Blue).size() == 14);

    REQUIRE(board.winner() == Winner::Undecided);
}

TEST_CASE("A variant rejects pawn kinds outside its roster", "[Game State]") {
    CHECK_THROWS((Board{3,
                        3,
                        Variant::Classic,
                        {{Player::Red, Pawn::Cat, {0, 0}},
                         {Player::Red, Pawn::Home, {2, 2}},
                         {Player::Red, Pawn::Mouse, {0, 2}},
                         {Player::Blue, Pawn::Cat, {2, 0}},
                         {Player::Blue, Pawn::Home, {0, 2}}}}));
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
    Board board = standard_board(3, 3, {0, 0}, {1, 0}, {2, 0}, {2, 2});

    board.take_step(Player::Red, Pawn::Mouse, Direction::Right);

    REQUIRE(board.mouse(Player::Red) == Cell{2, 0});
    REQUIRE(board.winner() == Winner::Blue);
}

TEST_CASE("Advance to win", "[Game State]") {
    Board board{3, 3};

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

TEST_CASE("Standard red goal is a win when Blue is one or two actions away", "[Game State]") {
    for (int blue_distance : {1, 2}) {
        CAPTURE(blue_distance);
        Cell const blue_cat = blue_distance == 1 ? Cell{0, 1} : Cell{1, 1};
        Board board = standard_board(3, 3, {2, 2}, {0, 2}, blue_cat, {2, 2});

        CHECK(board.winner() == Winner::Red);
        CHECK(board.winner(Turn{Player::Blue, Turn::First}) == Winner::Red);
        CHECK(board.winner(Turn{Player::Red, Turn::Second}) == Winner::Undecided);
        CHECK(board.score_for(Player::Red) == 1.0);
        CHECK(board.score_for(Player::Blue) == -1.0);
    }
}

TEST_CASE("Block walls", "[Game State]") {
    Board board{3, 3};
    board.place_wall(Player::Blue, {{0, 0}, Direction::Right});
    REQUIRE(board.is_blocked({{0, 0}, Direction::Right}));
    REQUIRE(board.legal_directions(Player::Red).size() == 1);
}

TEST_CASE("Distance", "[Game State]") {
    Board board{3, 3};
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
    Board board = standard_board(5, 5, {0, 0}, {2, 2}, {3, 2}, {4, 4});

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
    // Red's cat is one step left of Blue's mouse, so the capture is a Red win.
    Board board = standard_board(5, 5, {2, 2}, {0, 0}, {4, 4}, {3, 2});

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

TEST_CASE("score_for does not read a mid-turn walk-past as decided", "[Game State]") {
    // The position from the middle of Red's turn in the first case above: Red's mouse standing on
    // Blue's cat, with Red still holding an action.
    Board board = standard_board(5, 5, {0, 0}, {3, 2}, {3, 2}, {4, 4});

    // At a turn boundary this is a real capture and Red has lost outright.
    CHECK(board.score_for(Player::Red) == -1.0);
    CHECK(board.score_for(Player::Red, Turn{Player::Blue, Turn::First}) == -1.0);
    CHECK(board.score_for(Player::Blue, Turn{Player::Blue, Turn::First}) == 1.0);

    // Mid-turn it is not. Red's cat is 8 steps from its goal, and Blue's cat counts as ONE step from
    // Red's mouse - where it will be the moment the mouse steps aside - so the heuristic is -1 + 1/8.
    // Scoring a certain loss here would make the search shun a walk-past it is allowed to make;
    // scoring a flat 0 would make a lost position look level.
    double const red_mid = board.score_for(Player::Red, Turn{Player::Red, Turn::Second});
    double const blue_mid = board.score_for(Player::Blue, Turn{Player::Red, Turn::Second});
    CHECK(red_mid == Catch::Approx(-0.875));
    CHECK(red_mid > -1.0);
    CHECK(red_mid < 0.0);
    // The board is zero-sum, so the two views have to be opposites. They were not when only the
    // OPPONENT's zero distance was substituted: Blue still read an exact +1 from its own zero.
    CHECK(blue_mid == Catch::Approx(-red_mid));
}

TEST_CASE("score_for does not read a mid-turn capture as decided", "[Game State]") {
    // The mirror orientation: Red's cat standing on Blue's mouse, Red still holding an action.
    Board board = standard_board(5, 5, {3, 2}, {0, 0}, {4, 4}, {3, 2});

    // At a turn boundary Red has won outright.
    CHECK(board.score_for(Player::Red) == 1.0);

    // Mid-turn the capture can still be walked off, so it is worth a lot but not everything.
    double const red_mid = board.score_for(Player::Red, Turn{Player::Red, Turn::Second});
    double const blue_mid = board.score_for(Player::Blue, Turn{Player::Red, Turn::Second});
    CHECK(red_mid == Catch::Approx(0.875));
    CHECK(red_mid < 1.0);
    CHECK(blue_mid == Catch::Approx(-red_mid));
}

TEST_CASE("score_for survives a mid-turn where BOTH sides sit on a goal", "[Game State]") {
    // Red's cat has captured Blue's mouse and Red's own mouse is standing on Blue's cat - one turn
    // that both wins and strands. Only reachable now that a midpoint is never terminal, and it is
    // what makes suppressing the winner check on its own unsafe: both distances read zero, and the
    // untouched formula divides zero by zero.
    Board board = standard_board(5, 5, {3, 2}, {1, 1}, {1, 1}, {3, 2});

    double const red_mid = board.score_for(Player::Red, Turn{Player::Red, Turn::Second});
    double const blue_mid = board.score_for(Player::Blue, Turn{Player::Red, Turn::Second});

    // Level, and above all a NUMBER - a NaN would fail this comparison rather than pass it.
    CHECK(red_mid == 0.0);
    CHECK(blue_mid == 0.0);
}

TEST_CASE("Animal Cycle non-terminal score uses the nearest directed capture for each side",
          "[Training Contract]") {
    Board board{6,
                6,
                Variant::AnimalCycle,
                {{Player::Red, Pawn::Cat, {0, 0}},
                 {Player::Red, Pawn::Elephant, {0, 5}},
                 {Player::Blue, Pawn::Mouse, {2, 0}},
                 {Player::Blue, Pawn::Dog, {5, 5}}}};

    REQUIRE(board.winner() == Winner::Undecided);
    CHECK(board.score_for(Player::Red) == Catch::Approx(1.0 - 2.0 / 7.0));
    CHECK(board.score_for(Player::Blue) == Catch::Approx(-1.0 + 2.0 / 7.0));
    CHECK(board.score_for(Player::Blue) == Catch::Approx(-board.score_for(Player::Red)));
}

TEST_CASE("Animal Cycle capture is terminal after the capturing action", "[Training Contract]") {
    Board board{5,
                5,
                Variant::AnimalCycle,
                {{Player::Red, Pawn::Cat, {1, 0}},
                 {Player::Red, Pawn::Elephant, {4, 4}},
                 {Player::Blue, Pawn::Mouse, {0, 4}},
                 {Player::Blue, Pawn::Dog, {0, 0}}}};

    REQUIRE(board.winner() == Winner::Undecided);
    board.do_action(Player::Blue, PawnMove{Pawn::Dog, Direction::Right});
    CHECK(board.winner(Turn{Player::Blue, Turn::Second}) == Winner::Blue);
    CHECK(board.score_for(Player::Blue, Turn{Player::Blue, Turn::Second}) == 1.0);
    CHECK(board.score_for(Player::Red, Turn{Player::Blue, Turn::Second}) == -1.0);
}

/*
The notation emitter writes the actions a turn HAS, and a turn may legally have two, one, or none.

`Move::standard_notation` is the two-action case and must be unchanged by that generalisation, so it
is checked here against the same actions passed directly.
*/
TEST_CASE("turn_notation writes short turns", "[Game State]") {
    Board board = standard_board(5, 5, {0, 0}, {2, 2}, {4, 4}, {3, 2});

    SECTION("no actions at all is the pass token") {
        CHECK(turn_notation({}, board, Player::Red) == "---");
    }

    SECTION("one action is one term, with no separator") {
        std::array<Action, 1> const actions{PawnMove{Pawn::Cat, Direction::Right}};
        std::string const written = turn_notation(actions, board, Player::Red);

        CHECK(written.starts_with("C"));
        CHECK(written.find('.') == std::string::npos);
    }

    SECTION("two actions read exactly as Move::standard_notation does") {
        Action const first = PawnMove{Pawn::Cat, Direction::Right};
        Action const second = PawnMove{Pawn::Cat, Direction::Down};
        std::array<Action, 2> const actions{first, second};

        CHECK(turn_notation(actions, board, Player::Red) ==
              Move{first, second}.standard_notation(board, Player::Red));
    }
}

/*
The one terminal-after-action predicate the BGS handler, the naive fallback and the search all
now share. It answers "did that action make the game terminal?", NOT "did the mover win" - the
third section below is a case where the mover decided the game against itself.

Both halves are pinned here, including the trap that made a private copy dangerous: for a
non-Animal variant the game really is decided, and `winner(Turn{player, Second})` still answers
Undecided, because it is deliberately blind to a mid-turn position. Anything that asks THAT
question here gets "no" every time.
*/
TEST_CASE("turn_must_end_after_action covers both variants and a losing capture", "[Game State]") {
    SECTION("Standard: reaching the goal wins, and the Turn::Second query cannot see it") {
        Board const before = standard_board(5, 5, {0, 0}, {1, 1}, {4, 0}, {3, 3});
        Cell const red_goal = before.goal(Player::Red);
        CHECK_FALSE(turn_must_end_after_action(before, Player::Red));

        Board const after = standard_board(5, 5, red_goal, {1, 1}, {4, 0}, {3, 3});
        CHECK(turn_must_end_after_action(after, Player::Red));

        // The trap, stated as an assertion so it cannot be forgotten again.
        CHECK(after.winner(Turn{Player::Red, Turn::Second}) == Winner::Undecided);
    }

    /*
    The elephant, not the cat. Animal Cycle defines goal(Red) AS Blue's mouse, so `reached_goal`
    already sees a CAT capture and a cat-based case would pass under either predicate. Red's
    elephant taking Blue's dog also wins, and `reached_goal` is blind to it - that is the whole
    reason this predicate cannot be a bare `reached_goal`.
    */
    SECTION("Animal Cycle: a capture reached_goal cannot see still decides the game") {
        Board board{5,
                    5,
                    Variant::AnimalCycle,
                    {{Player::Red, Pawn::Cat, Cell{0, 0}},
                     {Player::Red, Pawn::Elephant, Cell{2, 2}},
                     {Player::Blue, Pawn::Mouse, Cell{4, 4}},
                     {Player::Blue, Pawn::Dog, Cell{3, 2}}}};

        CHECK_FALSE(turn_must_end_after_action(board, Player::Red));

        board.do_action(Player::Red, PawnMove{Pawn::Elephant, Direction::Right});
        CHECK(turn_must_end_after_action(board, Player::Red));
        CHECK(board.winner() == Winner::Red);
        // The divergence, pinned.
        CHECK_FALSE(board.reached_goal(Player::Red));
    }

    /*
    The mover can DECIDE THE GAME AGAINST ITSELF, and the turn must still stop.

    `legal_directions` excludes blocked paths and teammate collisions, and nothing else, so Red may
    legally step its own cat onto Blue's dog - and `animal_cycle_winner` scores dog-takes-cat for
    BLUE. This is the case that forbids narrowing the predicate to `winner == player`: doing so
    would let the turn continue after a losing capture, which is worse than the bug the shared
    predicate replaced. Raised by Reviewer 3 on 2026-08-20, after I wrongly judged it unreachable.
    */
    SECTION("Animal Cycle: a capture that loses the game also ends the turn") {
        Board board{5,
                    5,
                    Variant::AnimalCycle,
                    {{Player::Red, Pawn::Cat, Cell{2, 2}},
                     {Player::Red, Pawn::Elephant, Cell{0, 4}},
                     {Player::Blue, Pawn::Mouse, Cell{4, 4}},
                     {Player::Blue, Pawn::Dog, Cell{3, 2}}}};

        CHECK_FALSE(turn_must_end_after_action(board, Player::Red));

        board.do_action(Player::Red, PawnMove{Pawn::Cat, Direction::Right});

        // BLUE won, off RED's own action...
        CHECK(board.winner() == Winner::Blue);
        // ...and the predicate still says the turn is over. A `winner == player` test would say
        // "carry on" here.
        CHECK(turn_must_end_after_action(board, Player::Red));
    }
}

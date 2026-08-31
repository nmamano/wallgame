#include "state_conversions.hpp"

#include <algorithm>
#include <array>
#include <stdexcept>
#include <vector>

#include <catch2/catch_test_macros.hpp>

namespace {

float at(ModelInput const& input, Board const& board, int plane, Cell cell) {
    auto const board_size = board.columns() * board.rows();
    return input[plane * board_size + board.index_from_cell(cell)];
}

void require_constant_plane(ModelInput const& input, Board const& board, int plane, float value) {
    auto const board_size = board.columns() * board.rows();
    auto first = input.begin() + plane * board_size;
    REQUIRE(std::all_of(first, first + board_size,
                        [value](float actual) { return actual == value; }));
}

Board animal_board() {
    return Board{
        6,
        5,
        Variant::AnimalCycle,
        {
            {Player::Red, Pawn::Cat, {4, 1}},
            {Player::Red, Pawn::Elephant, {5, 4}},
            {Player::Blue, Pawn::Mouse, {1, 3}},
            {Player::Blue, Pawn::Dog, {0, 0}},
        },
    };
}

}  // namespace

TEST_CASE("Universal input uses one-hot variant planes and zero reservations",
          "[State Conversions]") {
    for (auto const [variant, active_plane] :
         std::array{std::pair{Variant::Classic, 9}, std::pair{Variant::Standard, 8},
                    std::pair{Variant::AnimalCycle, 10}}) {
        Board board = variant == Variant::AnimalCycle ? animal_board() : Board{6, 5, variant};
        auto input = convert_to_model_input(board, {Player::Red, Turn::First});
        REQUIRE(input.size() == 16 * 6 * 5);
        for (int plane = 8; plane < 16; ++plane) {
            require_constant_plane(input, board, plane, plane == active_plane ? 1.0f : 0.0f);
        }
    }
}

TEST_CASE("Classic and Standard preserve the first eight state planes",
          "[State Conversions]") {
    for (Variant variant : {Variant::Classic, Variant::Standard}) {
        Board board{6, 5, variant};
        for (Player player : {Player::Red, Player::Blue}) {
            for (auto action : {Turn::First, Turn::Second}) {
                auto legacy = convert_to_model_input(board, {player, action}, 8);
                auto universal = convert_to_model_input(board, {player, action});
                REQUIRE(std::equal(legacy.begin(), legacy.end(), universal.begin()));
            }
        }
    }
}

TEST_CASE("Animal Cycle planes follow player-relative capture order",
          "[State Conversions]") {
    Board board = animal_board();
    auto red = convert_to_model_input(board, {Player::Red, Turn::First});
    auto blue = convert_to_model_input(board, {Player::Blue, Turn::First});

    std::array red_landmarks{
        board.pawn_position(Player::Red, Pawn::Cat),
        board.pawn_position(Player::Blue, Pawn::Mouse),
        board.pawn_position(Player::Blue, Pawn::Dog),
        board.pawn_position(Player::Red, Pawn::Elephant),
    };
    std::array blue_landmarks{
        board.pawn_position(Player::Blue, Pawn::Mouse),
        board.pawn_position(Player::Red, Pawn::Elephant),
        board.pawn_position(Player::Red, Pawn::Cat),
        board.pawn_position(Player::Blue, Pawn::Dog),
    };
    for (int plane = 0; plane < 4; ++plane) {
        REQUIRE(at(red, board, plane, red_landmarks[plane]) == 0.0f);
        REQUIRE(at(blue, board, plane, blue_landmarks[plane]) == 0.0f);
    }

    REQUIRE(board.movable_pawns(Player::Red) == std::vector{Pawn::Cat, Pawn::Elephant});
    REQUIRE(board.movable_pawns(Player::Blue) == std::vector{Pawn::Mouse, Pawn::Dog});
}

TEST_CASE("Nine-channel universal inputs fail closed", "[State Conversions]") {
    Board board{6, 5, Variant::Standard};
    REQUIRE_THROWS_AS(convert_to_model_input(board, {Player::Red, Turn::First}, 9),
                      std::invalid_argument);
}

TEST_CASE("Universal policy indices and legal masks replay-audit every rules variant",
          "[Training Contract]") {
    for (Variant variant : {Variant::Classic, Variant::Standard, Variant::AnimalCycle}) {
        Board board = variant == Variant::AnimalCycle ? animal_board() : Board{6, 5, variant};
        Turn const turn{Player::Red, Turn::First};
        NodeInfo info{board, turn, 0.0f, 1, {}};
        for (Action const& action : board.legal_actions(turn.player)) {
            info.edges.push_back({action, 1, 0.0f, 0.0f});
        }

        auto const mask = legal_policy_mask(info);
        REQUIRE(mask.size() == 2 * 6 * 5 + 8);
        CHECK(std::count(mask.begin(), mask.end(), true) == info.edges.size());
        for (EdgeInfo const& edge : info.edges) {
            CHECK(mask[universal_policy_index(board, turn, edge.action)]);
        }

        auto const output = convert_to_model_output(info, 0.5f);
        CHECK(output.prior.size() == mask.size());
        for (std::size_t index = 0; index < mask.size(); ++index) {
            if (!mask[index]) CHECK(output.prior[index] == 0.0f);
        }
        if (variant == Variant::Classic) {
            CHECK(std::all_of(output.prior.end() - 4, output.prior.end(),
                              [](float prior) { return prior == 0.0f; }));
        }
    }
}

TEST_CASE("Training labels use the Standard capture winner", "[Training Contract]") {
    Board final_board{3,
                      3,
                      Variant::Standard,
                      {{Player::Red, Pawn::Cat, {2, 2}},
                       {Player::Red, Pawn::Mouse, {0, 2}},
                       {Player::Blue, Pawn::Cat, {1, 1}},
                       {Player::Blue, Pawn::Mouse, {2, 2}}}};
    REQUIRE(final_board.winner() == Winner::Red);
    REQUIRE(final_board.score_for(Player::Red) == 1.0);

    Board decision_board = final_board;
    decision_board.take_step(Player::Red, Pawn::Cat, Direction::Left);
    NodeInfo decision{decision_board, {Player::Red, Turn::First}, 0.0f, 1, {}};
    decision.edges.push_back({PawnMove{Pawn::Cat, Direction::Right}, 1, 0.0f, 0.0f});

    auto const red_label = convert_to_model_output(decision, 1.0f);
    CHECK(red_label.value == 1.0f);
    decision.turn.player = Player::Blue;
    auto const blue_label = convert_to_model_output(decision, -1.0f);
    CHECK(blue_label.value == -1.0f);
}

TEST_CASE("training values prefer faster wins and delay forced losses", "[Training Contract]") {
    float const immediate_win = training_value_target(Winner::Red, Player::Red, 0);
    float const delayed_win = training_value_target(Winner::Red, Player::Red, 1);
    float const immediate_loss = training_value_target(Winner::Blue, Player::Red, 0);
    float const delayed_loss = training_value_target(Winner::Blue, Player::Red, 1);

    CHECK(immediate_win == 1.0f);
    CHECK(delayed_win == MCTS::kTerminalTurnDiscount);
    CHECK(immediate_win > delayed_win);
    CHECK(immediate_loss == -1.0f);
    CHECK(delayed_loss == -MCTS::kTerminalTurnDiscount);
    CHECK(delayed_loss > immediate_loss);
    CHECK(training_value_target(Winner::Draw, Player::Red, 0) == 0.0f);
    CHECK(training_value_target(Winner::Draw, Player::Blue, 9) == 0.0f);
}

TEST_CASE("Animal movable pawns retain their locked policy slots", "[Training Contract]") {
    Board board = animal_board();
    std::size_t const moves = 2 * 6 * 5;
    CHECK(universal_policy_index(board, {Player::Red, Turn::First},
                                 PawnMove{Pawn::Cat, Direction::Right}) == moves);
    CHECK(universal_policy_index(board, {Player::Red, Turn::First},
                                 PawnMove{Pawn::Elephant, Direction::Left}) == moves + 6);
    CHECK(universal_policy_index(board, {Player::Blue, Turn::First},
                                 PawnMove{Pawn::Mouse, Direction::Down}) == moves + 1);
    CHECK(universal_policy_index(board, {Player::Blue, Turn::First},
                                 PawnMove{Pawn::Dog, Direction::Up}) == moves + 7);
}

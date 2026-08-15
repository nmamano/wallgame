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
            {Player::Red, Pawn::Dog, {0, 0}},
            {Player::Red, Pawn::Mouse, {1, 3}},
            {Player::Blue, Pawn::Cat, {4, 1}},
            {Player::Blue, Pawn::Elephant, {5, 4}},
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
        board.pawn_position(Player::Red, Pawn::Dog),
        board.pawn_position(Player::Blue, Pawn::Cat),
        board.pawn_position(Player::Blue, Pawn::Elephant),
        board.pawn_position(Player::Red, Pawn::Mouse),
    };
    std::array blue_landmarks{
        board.pawn_position(Player::Blue, Pawn::Cat),
        board.pawn_position(Player::Red, Pawn::Mouse),
        board.pawn_position(Player::Red, Pawn::Dog),
        board.pawn_position(Player::Blue, Pawn::Elephant),
    };
    for (int plane = 0; plane < 4; ++plane) {
        REQUIRE(at(red, board, plane, red_landmarks[plane]) == 0.0f);
        REQUIRE(at(blue, board, plane, blue_landmarks[plane]) == 0.0f);
    }

    REQUIRE(board.movable_pawns(Player::Red) == std::vector{Pawn::Dog, Pawn::Mouse});
    REQUIRE(board.movable_pawns(Player::Blue) == std::vector{Pawn::Cat, Pawn::Elephant});
}

TEST_CASE("Nine-channel universal inputs fail closed", "[State Conversions]") {
    Board board{6, 5, Variant::Standard};
    REQUIRE_THROWS_AS(convert_to_model_input(board, {Player::Red, Turn::First}, 9),
                      std::invalid_argument);
}

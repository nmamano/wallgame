#pragma once

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <ranges>
#include <vector>

#include "gamestate.hpp"

/*
Helpers shared by the BGS test files. Extracted from test/bgs_session.cpp when test/naive_move.cpp
needed the same two things - a starting-position config and a legality check - because a "simplified"
second copy of either would drift from the first and quietly stop testing the same position.
*/
namespace bgs_test {

// A fresh standard game as the V3 protocol describes it: cats in opposite corners, each mouse in the
// corner its owner is defending, no walls.
inline nlohmann::json make_standard_config(int width = 8, int height = 8) {
    nlohmann::json config;
    config["variant"] = "standard";
    config["boardWidth"] = width;
    config["boardHeight"] = height;
    config["initialState"]["pawns"]["p1"]["cat"] = {height - 1, 0};
    config["initialState"]["pawns"]["p1"]["mouse"] = {height - 1, width - 1};
    config["initialState"]["pawns"]["p2"]["cat"] = {0, width - 1};
    config["initialState"]["pawns"]["p2"]["mouse"] = {0, 0};
    config["initialState"]["walls"] = nlohmann::json::array();
    return config;
}

// Legality straight from the Board, NOT from a policy's edge list, so that an action which is legal
// at the start of a turn and illegal after the first action is caught.
inline bool is_legal_action(Board const& board, Player player, Action const& action) {
    if (auto const* pawn_move = std::get_if<PawnMove>(&action)) {
        std::vector<Direction> const dirs = board.legal_directions(player, pawn_move->pawn);
        return std::ranges::find(dirs, pawn_move->dir) != dirs.end();
    }

    std::vector<Wall> const walls = board.legal_walls();
    return std::ranges::find(walls, std::get<Wall>(action)) != walls.end();
}

}  // namespace bgs_test

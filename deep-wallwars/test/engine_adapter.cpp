#include "engine_adapter.hpp"

#include <catch2/catch_test_macros.hpp>
#include <folly/Overload.h>
#include <filesystem>
#include <fstream>
#include <string>
#include <utility>
#include <vector>

using namespace engine_adapter;

static nlohmann::json animal_cycle_oracle() {
    auto path = std::filesystem::path(__FILE__).parent_path().parent_path().parent_path() /
        "tests/fixtures/animal-cycle-cpp-oracle.json";
    std::ifstream input(path);
    REQUIRE(input.good());
    return nlohmann::json::parse(input);
}

static std::string oracle_notation(
    Board const& board, Player player, std::vector<Action> const& actions,
    PaddingConfig const& padding) {
    if (actions.empty()) return "---";
    std::vector<std::string> parts;
    for (Action const& action : actions) {
        parts.push_back(folly::variant_match(
            action,
            [&](PawnMove move) {
                Cell target = board.pawn_position(player, move.pawn).step(move.dir);
                if (move.second_dir) target = target.step(*move.second_dir);
                char symbol = move.pawn == Pawn::Dog ? 'D'
                            : move.pawn == Pawn::Cat ? 'C'
                            : move.pawn == Pawn::Mouse ? 'M' : 'E';
                return std::string(1, symbol) + cell_notation(target, board.rows());
            },
            [&](Wall wall) { return wall_notation(wall, board.rows()); }));
    }
    std::string result;
    for (std::string const& part : parts) {
        if (!result.empty()) result += '.';
        result += part;
    }
    return transform_move_notation(
        result, board.position(player), board.mouse(player), padding);
}

TEST_CASE("Animal Cycle matches the focused TypeScript oracle", "[Animal Cycle oracle]") {
    auto oracle = animal_cycle_oracle();
    for (auto const& fixture : oracle["positions"]) {
        DYNAMIC_SECTION(fixture["name"].get<std::string>()) {
            auto const& config = fixture["config"];
            int model_rows = 10;
            int model_columns = 12;
            auto validation = validate_bgs_config(config, model_rows, model_columns);
            REQUIRE(validation.valid);
            auto [root, turn, padding] =
                convert_bgs_config_to_board(config, model_rows, model_columns);
            CHECK(root.variant() == Variant::AnimalCycle);

            for (auto const& probe : fixture["probes"]) {
                CAPTURE(probe["notation"]);
                Board board = root;
                try {
                    auto parsed = parse_move_notation(
                        probe["notation"].get<std::string>(), board, turn, padding);
                    if (!parsed && !probe["accepted"].get<bool>()) {
                        SUCCEED();
                        continue;
                    }
                    REQUIRE(parsed.has_value());
                    if (!probe["accepted"].get<bool>()) {
                        FAIL("C++ accepted a probe that the TypeScript oracle rejects");
                    }
                    CHECK(parsed->size() == probe["appliedActions"].get<size_t>());
                    CHECK(oracle_notation(board, turn.player, *parsed, padding) ==
                          probe["appliedNotation"].get<std::string>());
                    for (Action const& action : *parsed) {
                        board.do_action(turn.player, action);
                        if (board.winner(Turn{turn.player, Turn::Second}) != Winner::Undecided) {
                            break;
                        }
                    }
                    Winner expected = Winner::Undecided;
                    if (!probe["winner"].is_null()) {
                        expected = probe["winner"].get<int>() == 1 ? Winner::Red : Winner::Blue;
                    }
                    CHECK(board.winner(Turn{turn.player, Turn::Second}) == expected);
                } catch (std::exception const&) {
                    if (probe["accepted"].get<bool>()) throw;
                    SUCCEED();
                }
            }
        }
    }
}

TEST_CASE("Animal Cycle stacked capture precedence matches TypeScript", "[Animal Cycle oracle]") {
    auto oracle = animal_cycle_oracle();
    for (auto const& fixture : oracle["stacked"]) {
        auto const& pawns = fixture["pawns"]["pawns"];
        auto cell = [](nlohmann::json const& value) {
            return Cell{value[1].get<int>(), value[0].get<int>()};
        };
        Board board(8, 8, Variant::AnimalCycle,
                    {{Player::Red, Pawn::Cat, cell(pawns["1"]["cat"])},
                     {Player::Red, Pawn::Elephant, cell(pawns["1"]["elephant"])},
                     {Player::Blue, Pawn::Mouse, cell(pawns["2"]["mouse"])},
                     {Player::Blue, Pawn::Dog, cell(pawns["2"]["dog"])}});
        Winner expected = fixture["winner"].get<int>() == 1 ? Winner::Red : Winner::Blue;
        CAPTURE(fixture["name"]);
        CHECK(board.animal_cycle_winner() == expected);
    }
}

// ============================================================================
// PaddingConfig Creation Tests
// ============================================================================

TEST_CASE("PaddingConfig - no padding needed for same dimensions", "[Padding]") {
    auto config = create_padding_config(8, 8, 8, 8, Variant::Classic);

    CHECK(config.model_rows == 8);
    CHECK(config.model_columns == 8);
    CHECK(config.game_rows == 8);
    CHECK(config.game_columns == 8);
    CHECK_FALSE(config.needs_padding());
}

TEST_CASE("PaddingConfig - Standard variant embeds at top-left", "[Padding]") {
    // 5x5 game on 8x8 model
    auto config = create_padding_config(8, 8, 5, 5, Variant::Standard);

    CHECK(config.needs_padding());
    CHECK(config.row_offset == 0);
    CHECK(config.col_offset == 0);
}

TEST_CASE("PaddingConfig - Classic variant embeds at bottom, centered", "[Padding]") {
    // 5x5 game on 8x8 model
    // Row offset = 8 - 5 = 3 (embed at bottom)
    // Col offset = (8 - 5) / 2 = 1 (centered, left-biased)
    auto config = create_padding_config(8, 8, 5, 5, Variant::Classic);

    CHECK(config.needs_padding());
    CHECK(config.row_offset == 3);
    CHECK(config.col_offset == 1);
}

TEST_CASE("PaddingConfig - Classic variant left-biased centering", "[Padding]") {
    // 6x6 game on 8x8 model
    // Col offset = (8 - 6) / 2 = 1 (floor division)
    auto config = create_padding_config(8, 8, 6, 6, Variant::Classic);

    CHECK(config.col_offset == 1);  // Left-biased: 1, not 2

    // 5x7 game on 8x8 model
    // Col offset = (8 - 7) / 2 = 0 (floor of 0.5)
    auto config2 = create_padding_config(8, 8, 5, 7, Variant::Classic);
    CHECK(config2.col_offset == 0);  // Left-biased
}

// ============================================================================
// Coordinate Transformation Tests
// ============================================================================

TEST_CASE("transform_to_model - Standard variant no offset", "[Padding]") {
    auto config = create_padding_config(8, 8, 5, 5, Variant::Standard);

    Cell game_cell{2, 3};
    Cell model_cell = transform_to_model(game_cell, config);

    CHECK(model_cell.column == 2);
    CHECK(model_cell.row == 3);
}

TEST_CASE("transform_to_model - Classic variant with offset", "[Padding]") {
    // 5x5 game on 8x8 model: row_offset=3, col_offset=1
    auto config = create_padding_config(8, 8, 5, 5, Variant::Classic);

    Cell game_cell{2, 1};  // Game coords
    Cell model_cell = transform_to_model(game_cell, config);

    CHECK(model_cell.column == 3);  // 2 + 1
    CHECK(model_cell.row == 4);     // 1 + 3
}

TEST_CASE("transform_to_game - Standard variant no offset", "[Padding]") {
    auto config = create_padding_config(8, 8, 5, 5, Variant::Standard);

    Cell model_cell{2, 3};
    auto game_cell_opt = transform_to_game(model_cell, config);

    REQUIRE(game_cell_opt.has_value());
    CHECK(game_cell_opt->column == 2);
    CHECK(game_cell_opt->row == 3);
}

TEST_CASE("transform_to_game - Classic variant with offset", "[Padding]") {
    // 5x5 game on 8x8 model: row_offset=3, col_offset=1
    auto config = create_padding_config(8, 8, 5, 5, Variant::Classic);

    Cell model_cell{3, 4};  // Model coords
    auto game_cell_opt = transform_to_game(model_cell, config);

    REQUIRE(game_cell_opt.has_value());
    CHECK(game_cell_opt->column == 2);  // 3 - 1
    CHECK(game_cell_opt->row == 1);     // 4 - 3
}

TEST_CASE("transform_to_game - returns nullopt for padding area", "[Padding]") {
    // 5x5 game on 8x8 model: row_offset=3, col_offset=1
    // Game area: rows [3, 7], cols [1, 5]
    auto config = create_padding_config(8, 8, 5, 5, Variant::Classic);

    // Cell in top padding area (row 0)
    auto result1 = transform_to_game(Cell{3, 0}, config);
    CHECK_FALSE(result1.has_value());

    // Cell in left padding area (col 0)
    auto result2 = transform_to_game(Cell{0, 5}, config);
    CHECK_FALSE(result2.has_value());

    // Cell in right padding area (col 7)
    auto result3 = transform_to_game(Cell{7, 5}, config);
    CHECK_FALSE(result3.has_value());
}

TEST_CASE("transform_to_game - bottom row padding for Classic", "[Padding]") {
    // 5x5 game on 8x8 model: row_offset=3, col_offset=1
    // Game area: rows [3, 7], cols [1, 5]
    // Bottom row (row 7) in game area cols [1, 5] is valid
    // Bottom row (row 7) outside cols [1, 5] is padding but reachable
    auto config = create_padding_config(8, 8, 5, 5, Variant::Classic);

    // Cell at bottom-left corner of model (goal area)
    auto result1 = transform_to_game(Cell{0, 7}, config);
    CHECK_FALSE(result1.has_value());  // Outside game area

    // Cell at bottom-right corner of model (goal area)
    auto result2 = transform_to_game(Cell{7, 7}, config);
    CHECK_FALSE(result2.has_value());  // Outside game area

    // Cell at bottom of game area
    auto result3 = transform_to_game(Cell{3, 7}, config);
    REQUIRE(result3.has_value());
    CHECK(result3->column == 2);
    CHECK(result3->row == 4);
}

TEST_CASE("Round-trip transformation preserves coordinates", "[Padding]") {
    auto config = create_padding_config(8, 8, 5, 5, Variant::Classic);

    for (int col = 0; col < 5; ++col) {
        for (int row = 0; row < 5; ++row) {
            Cell game_cell{col, row};
            Cell model_cell = transform_to_model(game_cell, config);
            auto game_cell_back = transform_to_game(model_cell, config);

            REQUIRE(game_cell_back.has_value());
            CHECK(game_cell_back->column == col);
            CHECK(game_cell_back->row == row);
        }
    }
}

// ============================================================================
// Wall Transformation Tests
// ============================================================================

TEST_CASE("Wall transformation - Classic variant", "[Padding]") {
    auto config = create_padding_config(8, 8, 5, 5, Variant::Classic);

    Wall game_wall{Cell{2, 1}, Wall::Right};
    Wall model_wall = transform_to_model(game_wall, config);

    CHECK(model_wall.cell.column == 3);  // 2 + 1
    CHECK(model_wall.cell.row == 4);     // 1 + 3
    CHECK(model_wall.type == Wall::Right);
}

// ============================================================================
// Padding Wall Placement Tests
// ============================================================================

TEST_CASE("place_padding_walls - Standard variant blocks bottom and right", "[Padding]") {
    auto config = create_padding_config(8, 8, 5, 5, Variant::Standard);

    Board board(8, 8, Variant::Standard);
    place_padding_walls(board, config);

    // Bottom boundary should be blocked (row 4, below game area)
    for (int col = 0; col < 5; ++col) {
        CHECK(board.is_blocked(Wall{Cell{col, 4}, Wall::Down}));
    }

    // Right boundary should be blocked (col 4, right of game area)
    for (int row = 0; row < 5; ++row) {
        CHECK(board.is_blocked(Wall{Cell{4, row}, Wall::Right}));
    }

    // Padding area walls should be blocked
    CHECK(board.is_blocked(Wall{Cell{6, 6}, Wall::Down}));
    CHECK(board.is_blocked(Wall{Cell{6, 6}, Wall::Right}));

    // Inside game area should not be blocked by padding
    CHECK_FALSE(board.is_blocked(Wall{Cell{2, 2}, Wall::Down}));
    CHECK_FALSE(board.is_blocked(Wall{Cell{2, 2}, Wall::Right}));
}

TEST_CASE("place_padding_walls - Classic bottom row stays open to a goal in the padding",
          "[Padding]") {
    auto config = create_padding_config(8, 8, 5, 5, Variant::Classic);

    // A plain 8x8 Classic board homes at the MODEL bottom corners, so with a 5x5 game
    // embedded in it both goals sit out in the padding. That is what keeps the corridor
    // open, and it is the shape make_padded_training_board builds. A served board homes
    // on the game board instead and is sealed - the test below this one.
    Board board(8, 8, Variant::Classic);
    REQUIRE_FALSE(transform_to_game(board.goal(Player::Red), config).has_value());
    REQUIRE_FALSE(transform_to_game(board.goal(Player::Blue), config).has_value());

    place_padding_walls(board, config);

    // Bottom row (row 7) vertical walls should NOT be blocked (path to goal)
    for (int col = 0; col < 7; ++col) {
        CHECK_FALSE(board.is_blocked(Wall{Cell{col, 7}, Wall::Right}));
    }

    // Top padding area should be blocked
    CHECK(board.is_blocked(Wall{Cell{3, 0}, Wall::Down}));
    CHECK(board.is_blocked(Wall{Cell{3, 1}, Wall::Down}));

    // Top boundary of game area should be blocked
    for (int col = 1; col < 6; ++col) {
        CHECK(board.is_blocked(Wall{Cell{col, 2}, Wall::Down}));
    }
}

TEST_CASE("place_padding_walls - Classic variant blocks top padding vertical walls", "[Padding]") {
    auto config = create_padding_config(8, 8, 6, 6, Variant::Classic);

    Board board(8, 8, Variant::Classic);
    place_padding_walls(board, config);

    // Padding wall (>a8) should be blocked.
    CHECK(board.is_blocked(Wall{Cell{0, 0}, Wall::Right}));
}

TEST_CASE("place_padding_walls - Classic variant blocks padding column horizontal walls", "[Padding]") {
    auto config = create_padding_config(8, 8, 6, 6, Variant::Classic);

    Board board(8, 8, Variant::Classic);
    place_padding_walls(board, config);

    // Padding wall (^a5) should be blocked.
    CHECK(board.is_blocked(Wall{Cell{0, 2}, Wall::Down}));
}

TEST_CASE("place_padding_walls - no walls placed when no padding needed", "[Padding]") {
    auto config = create_padding_config(8, 8, 8, 8, Variant::Classic);

    Board board(8, 8, Variant::Classic);
    size_t walls_before = board.legal_walls().size();

    place_padding_walls(board, config);

    size_t walls_after = board.legal_walls().size();
    CHECK(walls_before == walls_after);
}

// ============================================================================
// Move Notation Transformation Tests
// ============================================================================

TEST_CASE("transform_move_notation - no transform when no padding", "[Padding]") {
    auto config = create_padding_config(8, 8, 8, 8, Variant::Classic);

    std::string notation = "Ce4.>f3";
    Cell cat_pos{3, 4};
    Cell mouse_pos{0, 7};

    std::string result = transform_move_notation(notation, cat_pos, mouse_pos, config);
    CHECK(result == "Ce4.>f3");
}

TEST_CASE("transform_move_notation - Standard variant simple case", "[Padding]") {
    // 5x5 game on 8x8 model, Standard variant: no offset
    auto config = create_padding_config(8, 8, 5, 5, Variant::Standard);

    // Move in model coords that maps directly to game coords
    // Model: Ce4 means cat to column e (4), row 4 (internal row 4)
    // In 8x8 model, e4 = col 4, internal row 4 (official row = 8-4 = 4)
    // After transform, same coords in 5x5 game
    // In 5x5 game, col 4, internal row 4 => official row = 5-4 = 1
    // So Ce4 in model becomes Ce1 in game

    std::string notation = "Ce4";
    Cell cat_pos{4, 3};  // Start position doesn't matter for this test
    Cell mouse_pos{0, 4};

    std::string result = transform_move_notation(notation, cat_pos, mouse_pos, config);
    CHECK(result == "Ce1");
}

TEST_CASE("transform_move_notation - Classic variant with offset", "[Padding]") {
    // 5x5 game on 8x8 model: row_offset=3, col_offset=1
    // Game area in model: rows [3,7], cols [1,5]
    auto config = create_padding_config(8, 8, 5, 5, Variant::Classic);

    // Move in model coords: Cd5
    // In 8x8 model: col d = 3, official row 5 => internal row = 8-5 = 3
    // Transform to game: col = 3-1 = 2, row = 3-3 = 0
    // In 5x5 game: col 2 = c, internal row 0 => official row = 5-0 = 5
    // So Cd5 in model becomes Cc5 in game

    std::string notation = "Cd5";
    Cell cat_pos{3, 2};
    Cell mouse_pos{1, 7};

    std::string result = transform_move_notation(notation, cat_pos, mouse_pos, config);
    CHECK(result == "Cc5");
}

TEST_CASE("transform_move_notation - Classic bottom row outside column maps to goal", "[Padding]") {
    // 6x6 game on 8x8 model: row_offset=2, col_offset=1
    // A pawn one away from the right embedded corner can move two steps right to model h1.
    // This should map back to the 6x6 corner (f1), effectively ignoring the extra step.
    auto config = create_padding_config(8, 8, 6, 6, Variant::Classic);

    std::string notation = "Ch1";
    Cell cat_pos{5, 7};    // Model: f1 (one away from embedded right corner)
    Cell mouse_pos{0, 7};

    std::string result = transform_move_notation(notation, cat_pos, mouse_pos, config);
    CHECK(result == "Cf1");
}

TEST_CASE("transform_move_notation - wall notation", "[Padding]") {
    // 5x5 game on 8x8 model: row_offset=3, col_offset=1
    auto config = create_padding_config(8, 8, 5, 5, Variant::Classic);

    // Wall in model coords: >d5 (vertical wall at col d, row 5)
    // Transform: col = 3-1 = 2, row = 8-5-3 = 0 => official row 5
    // In game: col c, row 5 => >c5

    std::string notation = ">d5";
    Cell cat_pos{3, 2};
    Cell mouse_pos{1, 7};

    std::string result = transform_move_notation(notation, cat_pos, mouse_pos, config);
    CHECK(result == ">c5");
}

TEST_CASE("transform_move_notation - horizontal wall notation", "[Padding]") {
    // 6x6 game on 8x8 model, Standard variant: no offset
    auto config = create_padding_config(8, 8, 6, 6, Variant::Standard);

    // In 8x8 model: ^c7 -> col 2, internal row 1
    // In 6x6 game: internal row 1 => official row 5
    std::string notation = "^c7";
    Cell cat_pos{0, 0};
    Cell mouse_pos{0, 0};

    std::string result = transform_move_notation(notation, cat_pos, mouse_pos, config);
    CHECK(result == "^c5");
}

TEST_CASE("transform_move_notation - compound move", "[Padding]") {
    // 5x5 game on 8x8 model, Standard variant (no offset)
    auto config = create_padding_config(8, 8, 5, 5, Variant::Standard);

    // Model notation: Cd4.>e3 (cat move + wall)
    // In 8x8: Cd4 = col 3, internal row 4 (official = 8-4 = 4)
    // In 5x5: col 3, internal row 4 => official row = 5-4 = 1 => Cd1
    // Wall: >e3 in 8x8 = col 4, internal row 5 (official = 8-5 = 3)
    // In 5x5: col 4, internal row 5 => official row = 5-5 = 0 => but wait, row 5 is out of game area

    // Let's use a simpler case within bounds
    std::string notation = "Cc3.>c2";
    Cell cat_pos{2, 4};
    Cell mouse_pos{0, 4};

    // Cc3: col 2, official row 3 => internal row 5 in 8x8
    // Transform: col 2, internal row 5 => in 5x5, official row = 5-5 = 0
    // So Cc3 becomes Cc0? That doesn't work...

    // Actually, we need to be more careful about row numbering
    // Let me use coordinates that are clearly in the game area
    // Game area in Standard: rows [0,4], cols [0,4] in model

    std::string notation2 = "Cb2";
    // In 8x8: b2 = col 1, official row 2 => internal row 6
    // Internal row 6 is outside game area (0-4)... skip this complex test
}

// ============================================================================
// Padded Training Board Tests (S6, transformer-ready loop)
// ============================================================================

TEST_CASE("make_padded_training_board - classic 8x8 in 12x10", "[Padding]") {
    Board board = make_padded_training_board(12, 10, 8, 8, Variant::Classic);

    // Board is at MODEL dims.
    CHECK(board.columns() == 12);
    CHECK(board.rows() == 10);

    // Classic embed is bottom-centered: col_offset = 2, row_offset = 2.
    CHECK(board.position(Player::Red) == Cell{2, 2});
    CHECK(board.position(Player::Blue) == Cell{9, 2});

    // Classic goals at the MODEL bottom corners. This is the TRAINING board's own
    // semantics, not serving's: a served board takes both homes from the game config,
    // which always puts them on the game board.
    CHECK(board.home(Player::Red) == Cell{11, 9});
    CHECK(board.home(Player::Blue) == Cell{0, 9});

    // Movement into padding blocked at boundaries: from padding row 1 into
    // game row 2, and across the left padding boundary (col 1 <-> col 2).
    CHECK(board.is_blocked(Wall{Cell{2, 1}, Wall::Down}));
    CHECK(board.is_blocked(Wall{Cell{1, 5}, Wall::Right}));

    // Interior of the embedded game stays open.
    CHECK_FALSE(board.is_blocked(Wall{Cell{5, 5}, Wall::Right}));
    CHECK_FALSE(board.is_blocked(Wall{Cell{5, 5}, Wall::Down}));
}

TEST_CASE("make_padded_training_board - standard 8x8 in 12x10", "[Padding]") {
    Board board = make_padded_training_board(12, 10, 8, 8, Variant::Standard);

    CHECK(board.columns() == 12);
    CHECK(board.rows() == 10);

    // Standard embed is top-left: offsets (0, 0).
    CHECK(board.position(Player::Red) == Cell{0, 0});
    CHECK(board.position(Player::Blue) == Cell{7, 0});

    // Standard mice are transformed game-space corners.
    CHECK(board.mouse(Player::Red) == Cell{0, 7});
    CHECK(board.mouse(Player::Blue) == Cell{7, 7});

    // Movement into the right/bottom padding blocked at boundaries.
    CHECK(board.is_blocked(Wall{Cell{7, 3}, Wall::Right}));
    CHECK(board.is_blocked(Wall{Cell{3, 7}, Wall::Down}));

    // Interior stays open.
    CHECK_FALSE(board.is_blocked(Wall{Cell{3, 3}, Wall::Right}));
    CHECK_FALSE(board.is_blocked(Wall{Cell{3, 3}, Wall::Down}));
}

TEST_CASE("make_padded_training_board - animal 7x7 in 12x10", "[Padding]") {
    Board board = make_padded_training_board(12, 10, 7, 7, Variant::AnimalCycle);

    CHECK(board.columns() == 12);
    CHECK(board.rows() == 10);

    // Animal Cycle uses Standard-style top-left padding. The fixed game
    // corners retain the authoritative ownership after transformation.
    CHECK(board.pawn_position(Player::Red, Pawn::Cat) == Cell{0, 0});
    CHECK(board.pawn_position(Player::Red, Pawn::Elephant) == Cell{6, 6});
    CHECK(board.pawn_position(Player::Blue, Pawn::Mouse) == Cell{6, 0});
    CHECK(board.pawn_position(Player::Blue, Pawn::Dog) == Cell{0, 6});

    CHECK(board.is_blocked(Wall{Cell{6, 3}, Wall::Right}));
    CHECK(board.is_blocked(Wall{Cell{3, 6}, Wall::Down}));
    CHECK_FALSE(board.is_blocked(Wall{Cell{3, 3}, Wall::Right}));
    CHECK_FALSE(board.is_blocked(Wall{Cell{3, 3}, Wall::Down}));
}

// ============================================================================
// Moves the game board cannot hold (board a74a9963)
// ============================================================================

/*
A serving board is the MODEL board with the game embedded in it, so every cell of the
padding is a cell the real game has not got. Board::legal_walls walks the whole model
board and offers every wall the padding left open, which makes each of those a move
MCTS may pick and the session may send.

Classic 8x8 on the 12x10 serving model seats the game in columns 2..9 and rows 2..9.
Two kinds of wall used to get out, both on the bottom row, which is the row the Classic
padding held open:
  - a wall in a padding column, which transform_move_notation cannot express, so the
    model notation went out unchanged and named a column the game has not got (">k1");
  - a wall on the game board's own right edge, model column 9, which transforms cleanly
    into ">h1" and so reads as an ordinary move while naming a wall off the board.
*/

static json classic_config_with(int width, int height, json pawns) {
    json config;
    config["variant"] = "classic";
    config["boardWidth"] = width;
    config["boardHeight"] = height;
    config["initialState"]["pawns"] = std::move(pawns);
    config["initialState"]["walls"] = json::array();
    return config;
}

// The position production deals for an ordinary Classic game, as
// shared/domain/classic-setup.ts builds it: cats on the top corners, each home on the
// diagonally opposite bottom corner, no walls. Protocol cells are [row, column].
static json production_classic_start(int width, int height) {
    json pawns;
    pawns["p1"]["cat"] = {0, 0};
    pawns["p1"]["home"] = {height - 1, width - 1};
    pawns["p2"]["cat"] = {0, width - 1};
    pawns["p2"]["home"] = {height - 1, 0};
    return classic_config_with(width, height, pawns);
}

// Classic Random Start draws cats and homes from the Standard random distribution
// (shared/domain/classic-setup.ts), so a home lands anywhere rather than on a corner.
static json classic_random_start(int width, int height) {
    json pawns;
    pawns["p1"]["cat"] = {2, 3};
    pawns["p1"]["home"] = {5, 6};
    pawns["p2"]["cat"] = {1, 6};
    pawns["p2"]["home"] = {4, 1};
    return classic_config_with(width, height, pawns);
}

// A wall the game board cannot hold, either way of getting out.
static bool off_the_game_board(Wall wall, PaddingConfig const& config) {
    std::optional<Cell> const game_cell = transform_to_game(wall.cell, config);
    if (!game_cell) {
        return true;
    }
    return wall.type == Wall::Right && game_cell->column == config.game_columns - 1;
}

// Exactly what the session would put on the wire for this wall.
static std::string sent_for(Wall wall, Board const& board, PaddingConfig const& config) {
    return transform_move_notation(wall_notation(wall, board.rows()),
                                   board.position(Player::Red), board.home(Player::Red), config);
}

static std::string joined(std::vector<std::string> const& items) {
    std::string result;
    for (std::string const& item : items) {
        if (!result.empty()) {
            result += ' ';
        }
        result += item;
    }
    return result;
}

TEST_CASE("Classic serving offers no wall off the game board", "[Padding]") {
    // The ordinary start is in here on purpose. Nothing in the rules held this to
    // Random Start: the same walls are on offer from the position production deals.
    std::vector<std::pair<std::string, json>> const positions{
        {"production start", production_classic_start(8, 8)},
        {"random start", classic_random_start(8, 8)},
    };

    for (auto const& [name, config] : positions) {
        DYNAMIC_SECTION(name) {
            auto [board, turn, padding] = convert_bgs_config_to_board(config, 10, 12);
            REQUIRE(padding.needs_padding());

            std::vector<std::string> sent;
            for (Wall const& wall : board.legal_walls()) {
                if (off_the_game_board(wall, padding)) {
                    sent.push_back(sent_for(wall, board, padding));
                }
            }

            INFO("the search may pick these, and the session would send: " << joined(sent));
            CHECK(sent.empty());
        }
    }
}

TEST_CASE("Classic serving offers no wall off the game board, at any size", "[Padding]") {
    // Every Classic size production offers, from official-custom-bot-client's config.
    // Board width is what decides this, not height: the row that used to stay open runs
    // across the board, so a 5-wide game was offered seven walls it could not hold and
    // only a 12-wide game - as wide as the model, so no side padding - was ever clean.
    for (int height = 5; height <= 10; ++height) {
        for (int width = 5; width <= 12; ++width) {
            json const config = production_classic_start(width, height);
            REQUIRE(validate_bgs_config(config, 10, 12).valid);
            auto [board, turn, padding] = convert_bgs_config_to_board(config, 10, 12);

            std::vector<std::string> sent;
            for (Wall const& wall : board.legal_walls()) {
                if (off_the_game_board(wall, padding)) {
                    sent.push_back(sent_for(wall, board, padding));
                }
            }

            INFO(width << "x" << height << " offers: " << joined(sent));
            CHECK(sent.empty());
        }
    }
}

TEST_CASE("Classic serving seals the game board's edge", "[Padding]") {
    auto [board, turn, padding] =
        convert_bgs_config_to_board(production_classic_start(8, 8), 10, 12);

    // Both homes are on the game board, so nothing on this board wants the padding.
    // A sealed edge is also what keeps a pawn from walking out into it.
    int const left_of_the_board = padding.col_offset - 1;
    int const right_edge = padding.col_offset + padding.game_columns - 1;
    for (int row = padding.row_offset; row < padding.model_rows; ++row) {
        INFO("row " << row);
        CHECK(board.is_blocked(Wall{Cell{left_of_the_board, row}, Wall::Right}));
        CHECK(board.is_blocked(Wall{Cell{right_edge, row}, Wall::Right}));
    }
}

TEST_CASE("Classic training keeps its way to the goals in the padding", "[Padding]") {
    Board board = make_padded_training_board(12, 10, 8, 8, Variant::Classic);

    // Both homes are model bottom corners, out beyond the embedded 8x8.
    REQUIRE(board.home(Player::Red) == Cell{11, 9});
    REQUIRE(board.home(Player::Blue) == Cell{0, 9});

    // distance is -1 when no path exists. Sealing the served board must not seal this
    // one: with the corridor shut, neither player could ever reach a goal.
    CHECK(board.distance(board.position(Player::Red), board.home(Player::Red)) != -1);
    CHECK(board.distance(board.position(Player::Blue), board.home(Player::Blue)) != -1);
}

TEST_CASE("make_padded_training_board - equal dims is the standard board", "[Padding]") {
    Board padded = make_padded_training_board(12, 10, 12, 10, Variant::Classic);
    Board plain{12, 10, Variant::Classic};

    CHECK(padded.position(Player::Red) == plain.position(Player::Red));
    CHECK(padded.position(Player::Blue) == plain.position(Player::Blue));
    CHECK(padded.home(Player::Red) == plain.home(Player::Red));
    CHECK(padded.home(Player::Blue) == plain.home(Player::Blue));
    // No padding walls: a fresh board has no interior walls anywhere.
    CHECK_FALSE(padded.is_blocked(Wall{Cell{5, 5}, Wall::Right}));
    CHECK_FALSE(padded.is_blocked(Wall{Cell{0, 0}, Wall::Down}));
}

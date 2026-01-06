-- Backfill initialState for games that don't have it (Standard/Classic variants)
-- This migration adds default corner positions based on board dimensions.

-- For Standard/Freestyle games without initialState:
-- P1: cat (0,0), mouse (height-1, 0)
-- P2: cat (0, width-1), mouse (height-1, width-1)
UPDATE "game_details" gd
SET "config_parameters" = jsonb_set(
  COALESCE(gd.config_parameters, '{}'::jsonb),
  '{initialState}',
  jsonb_build_object(
    'pawns', jsonb_build_object(
      '1', jsonb_build_object(
        'cat', jsonb_build_array(0, 0),
        'mouse', jsonb_build_array(g.board_height - 1, 0)
      ),
      '2', jsonb_build_object(
        'cat', jsonb_build_array(0, g.board_width - 1),
        'mouse', jsonb_build_array(g.board_height - 1, g.board_width - 1)
      )
    ),
    'walls', '[]'::jsonb
  )
)
FROM "games" g
WHERE gd.game_id = g.game_id
  AND g.variant IN ('standard', 'freestyle')
  AND (gd.config_parameters IS NULL OR gd.config_parameters->'initialState' IS NULL);

-- For Classic games without initialState:
-- P1: cat (0,0), home (height-1, width-1)
-- P2: cat (height-1, width-1), home (0, 0)
UPDATE "game_details" gd
SET "config_parameters" = jsonb_set(
  COALESCE(gd.config_parameters, '{}'::jsonb),
  '{initialState}',
  jsonb_build_object(
    'pawns', jsonb_build_object(
      '1', jsonb_build_object(
        'cat', jsonb_build_array(0, 0),
        'home', jsonb_build_array(g.board_height - 1, g.board_width - 1)
      ),
      '2', jsonb_build_object(
        'cat', jsonb_build_array(g.board_height - 1, g.board_width - 1),
        'home', jsonb_build_array(0, 0)
      )
    ),
    'walls', '[]'::jsonb
  )
)
FROM "games" g
WHERE gd.game_id = g.game_id
  AND g.variant = 'classic'
  AND (gd.config_parameters IS NULL OR gd.config_parameters->'initialState' IS NULL);

-- For Survival games with old format (separate survival field):
-- Merge survival settings into initialState
UPDATE "game_details" gd
SET "config_parameters" = jsonb_set(
  gd.config_parameters,
  '{initialState}',
  jsonb_build_object(
    'cat', COALESCE(
      gd.config_parameters->'survival'->'initialPawns'->'p1Cat',
      jsonb_build_array(0, 0)
    ),
    'mouse', COALESCE(
      gd.config_parameters->'survival'->'initialPawns'->'p2Mouse',
      jsonb_build_array(g.board_height - 1, g.board_width - 1)
    ),
    'turnsToSurvive', gd.config_parameters->'survival'->'turnsToSurvive',
    'mouseCanMove', gd.config_parameters->'survival'->'mouseCanMove',
    'walls', COALESCE(gd.config_parameters->'initialState'->'walls', '[]'::jsonb)
  )
)
FROM "games" g
WHERE gd.game_id = g.game_id
  AND g.variant = 'survival'
  AND gd.config_parameters->'survival' IS NOT NULL
  AND gd.config_parameters->'initialState'->'turnsToSurvive' IS NULL;

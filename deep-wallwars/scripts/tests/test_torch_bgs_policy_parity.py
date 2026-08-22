import json

import pytest
import torch

from verify_torch_bgs_policy_parity import (
    expected_indices,
    fixture_config,
    read_transcript,
    require_fixture_sessions,
)


class FixedPolicy(torch.nn.Module):
    columns = 1
    rows = 1

    def __init__(self, first, second):
        super().__init__()
        self.first = first
        self.second = second

    def forward(self, inputs):
        priors = torch.tensor([[self.first, self.second]], dtype=torch.float32)
        return priors, torch.zeros((inputs.shape[0], 1))


def response(chosen):
    return {
        "policyProbe": {
            "positions": [
                {
                    "input": [0.0] * 16,
                    "legalActions": [{"policyIndex": 0}, {"policyIndex": 1}],
                }
            ],
            "chosenPolicyIndices": [chosen],
        }
    }


def test_expected_indices_accepts_a_safe_matching_torch_argmax():
    expected, margins = expected_indices(FixedPolicy(0.25, 0.75), response(1))
    assert expected == [1]
    assert margins == pytest.approx([0.5])


def test_expected_indices_rejects_a_wrong_bgs_choice():
    with pytest.raises(ValueError, match="Torch/BGS policy argmax mismatch"):
        expected_indices(FixedPolicy(0.25, 0.75), response(0))


def test_expected_indices_rejects_a_numerical_tie():
    with pytest.raises(ValueError, match="policy margin"):
        expected_indices(FixedPolicy(0.5, 0.5), response(0))


def test_fixture_config_matches_the_exact_session_request(tmp_path):
    initial_state = {"pawns": {"p1": {}, "p2": {}}, "walls": []}
    expected = {
        "variant": "classic",
        "boardWidth": 12,
        "boardHeight": 10,
        "initialState": initial_state,
    }
    transcript = tmp_path / "run.jsonl"
    rows = [
        {"type": "start_game_session", "bgsId": "fixture", "config": expected},
        {"type": "game_session_started", "bgsId": "fixture", "success": True},
        {
            "type": "evaluate_response",
            "bgsId": "fixture",
            "success": True,
            "bestMove": "Ca1",
        },
    ]
    transcript.write_text("".join(f"{json.dumps(row)}\n" for row in rows))
    _, actual = read_transcript(transcript)
    assert actual == fixture_config(
        {"variant": "classic", "board": "12x10", "initialState": initial_state}
    )


def test_swapped_fixture_row_fails_against_unchanged_engine_transcript(tmp_path):
    first_state = {"pawns": {"p1": {"cat": [0, 0]}, "p2": {}}, "walls": []}
    swapped_state = {"pawns": {"p1": {"cat": [1, 0]}, "p2": {}}, "walls": []}
    session_config = {
        "variant": "classic",
        "boardWidth": 12,
        "boardHeight": 10,
        "initialState": first_state,
    }
    transcript = tmp_path / "unchanged.jsonl"
    rows = [
        {"type": "start_game_session", "bgsId": "fixture", "config": session_config},
        {"type": "game_session_started", "bgsId": "fixture", "success": True},
        {
            "type": "evaluate_response",
            "bgsId": "fixture",
            "success": True,
            "bestMove": "Ca1",
        },
    ]
    transcript.write_text("".join(f"{json.dumps(row)}\n" for row in rows))
    _, actual = read_transcript(transcript)
    swapped = fixture_config(
        {"variant": "classic", "board": "12x10", "initialState": swapped_state}
    )
    with pytest.raises(ValueError, match="fixture/session config mismatch"):
        require_fixture_sessions(swapped, [(transcript, ({}, actual))])

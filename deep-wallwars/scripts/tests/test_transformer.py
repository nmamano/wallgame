"""CPU-only tests for WallgameTransformer (slice S2, transformer-ready loop).

Cell-order source of truth: Board::index_from_cell = column * rows + row
(src/gamestate.cpp:781). Tests use NON-SQUARE dims wherever order matters,
because square boards cannot distinguish col*rows+row from row*cols+col.
"""

import pytest
import torch

from export_transformer import should_export_resnet_reference

from model import (
    MODEL_INPUT_CHANNELS,
    ResNet,
    WallgameTransformer,
    arrange_policy,
    build_position_table,
)


def test_universal_input_contract_has_sixteen_planes():
    assert MODEL_INPUT_CHANNELS == 16

COLS, ROWS = 12, 10  # non-square on purpose


def tiny(columns=COLS, rows=ROWS, **overrides):
    torch.manual_seed(0)
    config = dict(d_model=32, layers=1, heads=4)
    config.update(overrides)
    return WallgameTransformer(columns, rows, **config)


def test_arrange_policy_exact_type_major_order():
    # 3 columns x 2 rows -> N = 6 (non-square).
    n_cells, moves_n = 6, 8
    wall = torch.zeros(1, n_cells, 2)
    for t in range(n_cells):
        wall[0, t, 0] = t  # type 0 (right walls)
        wall[0, t, 1] = 100 + t  # type 1 (down walls)
    moves = torch.arange(moves_n, dtype=torch.float32)[None] + 1000
    out = arrange_policy(wall, moves)
    expected = torch.tensor(
        [
            [
                # all type-0 cell logits in index_from_cell order...
                0.0, 1, 2, 3, 4, 5,
                # ...then all type-1...
                100, 101, 102, 103, 104, 105,
                # ...then the global-token move logits.
                1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007,
            ]
        ]
    )
    assert torch.equal(out, expected)


def test_position_table_index_from_cell_order():
    # Distinguishes col*rows+row from row*cols+col via non-square dims and
    # explicit per-cell expected values.
    columns, rows, d = 3, 2, 4
    col = torch.arange(columns, dtype=torch.float32)[:, None].expand(columns, d) * 10
    row = torch.arange(rows, dtype=torch.float32)[:, None].expand(rows, d)
    table = build_position_table(col, row)
    assert table.shape == (columns * rows, d)
    for c in range(columns):
        for r in range(rows):
            t = c * rows + r  # Board::index_from_cell (gamestate.cpp:781)
            assert torch.equal(table[t], torch.full((d,), float(10 * c + r)))


@pytest.mark.parametrize("cols,rows", [(12, 10), (8, 8), (5, 5)])
@pytest.mark.parametrize("stem", ["pointwise", "conv"])
def test_forward_shapes(cols, rows, stem):
    m = tiny(cols, rows, stem=stem, stem_blocks=1)
    x = torch.randn(3, MODEL_INPUT_CHANNELS, cols, rows)
    priors, value = m(x)
    assert priors.shape == (3, 2 * cols * rows + 8)
    assert value.shape == (3, 1)
    assert value.abs().max() <= 1.0


def test_cell_order_marker_distinguishes_transpose():
    # With zero encoder layers, a pointwise stem, and zeroed position tables,
    # the wall logit at token t depends ONLY on the input at cell
    # (col = t // rows, row = t % rows). A marker at (col=2, row=0) on a
    # 3x2 board must surface at t = 2*2+0 = 4; the transposed formula would
    # put it at t = 0*3+2 = 2.
    cols, rows = 3, 2
    n_cells = cols * rows
    m = tiny(cols, rows, layers=0)
    with torch.no_grad():
        m.col_embedding.zero_()
        m.row_embedding.zero_()
    m.log_output = False

    x = torch.zeros(1, MODEL_INPUT_CHANNELS, cols, rows)
    base, _ = m(x)
    marked_col, marked_row = 2, 0
    t_correct = marked_col * rows + marked_row  # 4
    t_transposed = marked_row * cols + marked_col  # 2

    marked = x.clone()
    marked[0, :, marked_col, marked_row] = 5.0
    out, _ = m(marked)

    delta = (out - base)[0].abs()
    for wall_type in range(2):
        block = delta[wall_type * n_cells : (wall_type + 1) * n_cells]
        assert block.argmax().item() == t_correct
        # Softmax renormalization moves every output slightly; the marked
        # cell must still exceed the transposed candidate.
        assert block[t_correct] > block[t_transposed]


def test_log_output_flag_probabilities():
    m = tiny()
    x = torch.randn(2, MODEL_INPUT_CHANNELS, COLS, ROWS)
    m.log_output = False
    priors, _ = m(x)
    assert torch.allclose(priors.sum(dim=1), torch.ones(2), atol=1e-5)
    m.log_output = True
    log_priors, _ = m(x)
    assert log_priors.max() <= 0
    assert torch.allclose(log_priors.exp().sum(dim=1), torch.ones(2), atol=1e-4)


def test_onnx_export_names_and_shapes(tmp_path):
    onnx = pytest.importorskip("onnx")
    m = tiny(layers=2)
    m.log_output = False  # export mode, mirroring training.py
    m.eval()  # NOTE: training.py does not call eval() before export; flagged for S4.
    path = str(tmp_path / "transformer.onnx")
    dummy = torch.randn(2, MODEL_INPUT_CHANNELS, COLS, ROWS)
    # Same call shape as training.py's export.
    torch.onnx.export(
        m, dummy, path, input_names=["States"], output_names=["Priors", "Values"]
    )
    g = onnx.load(path)
    onnx.checker.check_model(g)
    outs = {
        o.name: [d.dim_value for d in o.type.tensor_type.shape.dim]
        for o in g.graph.output
    }
    assert set(outs) == {"Priors", "Values"}
    assert outs["Priors"][-1] == 2 * COLS * ROWS + 8
    assert outs["Values"][-1] == 1
    assert "States" in {i.name for i in g.graph.input}
    states = next(i for i in g.graph.input if i.name == "States")
    assert [d.dim_value for d in states.type.tensor_type.shape.dim] == [
        2,
        MODEL_INPUT_CHANNELS,
        COLS,
        ROWS,
    ]


def test_trained_checkpoint_export_skips_legacy_resnet_reference():
    assert should_export_resnet_reference(None)
    assert not should_export_resnet_reference("model_1.pt")


def test_param_count_default_config_sane():
    m = WallgameTransformer(COLS, ROWS)
    n = sum(p.numel() for p in m.parameters())
    assert 2_000_000 < n < 30_000_000


def test_explicit_non_contract_channel_count_for_debugging():
    m = tiny(channels=8)
    priors, value = m(torch.randn(1, 8, COLS, ROWS))
    assert priors.shape == (1, 2 * COLS * ROWS + 8)
    assert value.shape == (1, 1)


def test_resnet_untouched_regression():
    torch.manual_seed(0)
    r = ResNet(5, 5, 16, 2, move_channels=4)
    p, v = r(torch.randn(2, MODEL_INPUT_CHANNELS, 5, 5))
    assert p.shape == (2, 2 * 25 + 4)
    assert v.shape == (2, 1)

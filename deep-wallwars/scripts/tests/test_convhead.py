"""CPU-only tests for ConvHeadResNet (slice S5, transformer-ready loop).

The control model: ResNet body + size-free heads. The key contract property
is that Conv2d(hidden, 2, 1) output flattened with flatten(1) natively
produces priors[type * C*R + cell] in Board::index_from_cell order.
Non-square dims everywhere order matters.
"""

import pytest
import torch

from model import ConvHeadResNet, arrange_policy

COLS, ROWS = 12, 10  # non-square on purpose


def tiny(columns=COLS, rows=ROWS, **overrides):
    torch.manual_seed(0)
    config = dict(hidden_channels=16, layers=1)
    config.update(overrides)
    return ConvHeadResNet(columns, rows, **config)


def test_flatten_order_equals_arrange_policy():
    # Exact-value equivalence on non-square dims: the convhead wall path
    # (B,2,C,R).flatten(1) must equal the S2 arrange_policy layout for the
    # same per-cell values.
    batch, cols, rows, moves_n = 2, 3, 2, 8
    torch.manual_seed(1)
    walls_bchw = torch.randn(batch, 2, cols, rows)
    moves = torch.randn(batch, moves_n)

    conv_path = torch.cat([walls_bchw.flatten(1), moves], dim=1)

    # Same values as (B, N, 2) in index_from_cell order (cell = c*rows + r):
    walls_bn2 = walls_bchw.permute(0, 2, 3, 1).reshape(batch, cols * rows, 2)
    reference = arrange_policy(walls_bn2, moves)

    assert torch.equal(conv_path, reference)


@pytest.mark.parametrize("cols,rows", [(12, 10), (8, 8), (5, 5)])
def test_forward_shapes(cols, rows):
    m = tiny(cols, rows)
    x = torch.randn(3, 9, cols, rows)
    priors, value = m(x)
    assert priors.shape == (3, 2 * cols * rows + 8)
    assert value.shape == (3, 1)
    assert value.abs().max() <= 1.0


def test_stores_board_dims_for_resume_checks():
    m = tiny(7, 5)
    assert (m.columns, m.rows, m.move_channels) == (7, 5, 8)


def test_log_output_flag_probabilities():
    m = tiny()
    m.eval()  # BatchNorm: eval mode for deterministic comparison
    x = torch.randn(2, 9, COLS, ROWS)
    m.log_output = False
    priors, _ = m(x)
    assert torch.allclose(priors.sum(dim=1), torch.ones(2), atol=1e-5)
    m.log_output = True
    log_priors, _ = m(x)
    assert log_priors.max() <= 0
    assert torch.allclose(log_priors.exp().sum(dim=1), torch.ones(2), atol=1e-4)


def test_onnx_export_names_and_shapes(tmp_path):
    onnx = pytest.importorskip("onnx")
    m = tiny()
    m.log_output = False
    m.eval()
    path = str(tmp_path / "convhead.onnx")
    dummy = torch.randn(2, 9, COLS, ROWS)
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


def test_param_count_no_size_tied_weights():
    # Same param count for different board sizes = no size-tied weights.
    n_small = sum(p.numel() for p in tiny(5, 4).parameters())
    n_large = sum(p.numel() for p in tiny(12, 10).parameters())
    assert n_small == n_large

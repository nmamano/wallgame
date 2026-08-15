import torch
import torch.nn as nn
import torch.nn.functional as fn

MODEL_INPUT_CHANNELS = 16


class ResNet(nn.Module):
    def __init__(self, columns, rows, hidden_channels, layers, move_channels=4):
        super().__init__()
        self.move_channels = move_channels

        self.start = nn.Sequential(
            nn.Conv2d(
                MODEL_INPUT_CHANNELS, hidden_channels, kernel_size=3, padding=1, bias=False
            ),
            nn.BatchNorm2d(hidden_channels),
            nn.ReLU(),
        )

        self.layers = nn.ModuleList([ResLayer(hidden_channels) for _ in range(layers)])

        self.priors = nn.Sequential(
            nn.Conv2d(hidden_channels, 32, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm2d(32),
            nn.ReLU(),
            nn.Flatten(),
            nn.Linear(32 * columns * rows, 2 * columns * rows + move_channels),
        )

        self.log_output = True

        self.value = nn.Sequential(
            nn.Conv2d(hidden_channels, 32, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm2d(32),
            nn.ReLU(),
            nn.Flatten(),
            nn.Linear(32 * columns * rows, 1),
            nn.Tanh(),
        )

    def forward(self, x):
        x = self.start.forward(x)

        for layer in self.layers:
            x = layer.forward(x)

        priors = self.priors.forward(x)
        if self.log_output:
            priors = fn.log_softmax(priors, dim=1)
        else:
            priors = fn.softmax(priors, dim=1)

        value = self.value.forward(x)

        return priors, value


class ResLayer(nn.Module):
    def __init__(self, channels):
        super().__init__()
        self.conv1 = nn.Conv2d(channels, channels, kernel_size=3, padding=1, bias=False)
        self.bn1 = nn.BatchNorm2d(channels)
        self.conv2 = nn.Conv2d(channels, channels, kernel_size=3, padding=1, bias=False)
        self.bn2 = nn.BatchNorm2d(channels)

    def forward(self, x):
        residual = x
        x = fn.relu(self.bn1.forward(self.conv1.forward(x)))
        x = fn.relu(residual + self.bn2.forward(self.conv2.forward(x)))
        return x


def build_position_table(col_embedding, row_embedding):
    """Outer-sum position table in Board::index_from_cell order.

    col_embedding: (columns, d). row_embedding: (rows, d).
    Returns (columns * rows, d) where entry [column * rows + row] equals
    col_embedding[column] + row_embedding[row]. This matches
    Board::index_from_cell = cell.column * m_rows + cell.row
    (src/gamestate.cpp:781) and torch's row-major flatten of spatial dims
    ordered (columns, rows): token t -> col = t // rows, row = t % rows.
    """
    columns, d = col_embedding.shape
    rows = row_embedding.shape[0]
    table = col_embedding[:, None, :] + row_embedding[None, :, :]
    return table.reshape(columns * rows, d)


def arrange_policy(wall_logits, move_logits):
    """Assemble the priors vector in the C++ contract order.

    wall_logits: (B, N, 2) per-CELL logits in index_from_cell order
    (column * rows + row); last dim is wall type (0 = right, 1 = down).
    move_logits: (B, M) logits from the GLOBAL token (M = move_channels;
    cat R/D/L/U then mouse R/D/L/U). They are NOT per-cell.

    Returns (B, 2N + M): priors[type * N + cell] for walls, then the move
    logits, exactly the layout consumed by src/batched_model_policy.cpp.
    """
    batch = wall_logits.shape[0]
    walls = wall_logits.permute(0, 2, 1).reshape(batch, -1)  # type-major
    return torch.cat([walls, move_logits], dim=1)


class ConvHeadResNet(nn.Module):
    """Control model: ResNet body + SIZE-FREE heads, no attention.

    Isolates the "size-free per-cell heads" variable from the "attention"
    variable (WallgameTransformer has both). Same I/O contract as ResNet.

    Wall head: 1x1 conv -> (B, 2, C, R); flatten(1) natively yields the
    contract layout priors[type * C*R + cell] (type-major blocks, row-major
    (C, R) cell order = Board::index_from_cell). Move and value heads:
    global average pool -> Linear. No board-size-tied weights anywhere;
    columns/rows are stored only for resume-time shape checks.
    """

    def __init__(self, columns, rows, hidden_channels, layers, move_channels=8,
                 channels=MODEL_INPUT_CHANNELS):
        super().__init__()
        self.columns = columns
        self.rows = rows
        self.move_channels = move_channels
        self.log_output = True

        self.start = nn.Sequential(
            nn.Conv2d(channels, hidden_channels, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm2d(hidden_channels),
            nn.ReLU(),
        )
        self.layers = nn.ModuleList(
            [ResLayer(hidden_channels) for _ in range(layers)]
        )
        self.wall_head = nn.Conv2d(hidden_channels, 2, kernel_size=1)
        self.move_head = nn.Linear(hidden_channels, move_channels)
        self.value_head = nn.Sequential(
            nn.Linear(hidden_channels, hidden_channels),
            nn.ReLU(),
            nn.Linear(hidden_channels, 1),
            nn.Tanh(),
        )

    def forward(self, x):
        x = self.start(x)
        for layer in self.layers:
            x = layer(x)

        wall_logits = self.wall_head(x).flatten(1)  # (B, 2*C*R) contract order
        pooled = x.mean(dim=(2, 3))  # global average pool over cells
        move_logits = self.move_head(pooled)
        priors = torch.cat([wall_logits, move_logits], dim=1)
        if self.log_output:
            priors = fn.log_softmax(priors, dim=1)
        else:
            priors = fn.softmax(priors, dim=1)

        value = self.value_head(pooled)
        return priors, value


class WallgameTransformer(nn.Module):
    """Transformer with per-token heads; same I/O contract as ResNet.

    Input: (B, 16, columns, rows) for the universal runtime contract.
    Output: (priors (B, 2*columns*rows + move_channels), value (B, 1)).
    Same log_output flag semantics as ResNet (log_softmax for training,
    softmax for export); value is tanh'd in-model.

    Wall logits are per-cell (a tiny Linear applied to every cell token);
    the move logits come from a learned GLOBAL token and are appended
    after the wall block. The heads contain no board-size-dependent
    weights: only the position tables are sized to (columns, rows).
    """

    def __init__(
        self,
        columns,
        rows,
        d_model=256,
        layers=10,
        move_channels=8,
        heads=8,
        stem="pointwise",
        stem_blocks=2,
        channels=MODEL_INPUT_CHANNELS,
    ):
        super().__init__()
        self.columns = columns
        self.rows = rows
        self.move_channels = move_channels
        self.log_output = True

        if stem == "pointwise":
            self.stem = nn.Conv2d(channels, d_model, kernel_size=1)
        elif stem == "conv":
            # Explicit projection to transformer width, then reuse ResLayer
            # blocks at that width (both are board-size-agnostic).
            self.stem = nn.Sequential(
                nn.Conv2d(channels, d_model, kernel_size=1),
                *[ResLayer(d_model) for _ in range(stem_blocks)],
            )
        else:
            raise ValueError(f"unknown stem: {stem!r}")

        self.col_embedding = nn.Parameter(torch.randn(columns, d_model) * 0.02)
        self.row_embedding = nn.Parameter(torch.randn(rows, d_model) * 0.02)
        self.global_token = nn.Parameter(torch.randn(1, 1, d_model) * 0.02)

        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=heads,
            # Explicit: PyTorch's default dim_feedforward is a fixed 2048,
            # which for small d_model would be an accidental 8x.
            dim_feedforward=4 * d_model,
            dropout=0.0,
            activation="gelu",
            batch_first=True,
            norm_first=True,
        )
        # layers=0 gives the bare stem+heads model (useful for debugging and
        # for locality-based tests); nn.TransformerEncoder itself cannot run
        # with an empty layer list.
        self.encoder = (
            nn.TransformerEncoder(
                encoder_layer, num_layers=layers, enable_nested_tensor=False
            )
            if layers > 0
            else None
        )
        self.final_norm = nn.LayerNorm(d_model)

        self.wall_head = nn.Linear(d_model, 2)
        self.move_head = nn.Linear(d_model, move_channels)
        self.value_head = nn.Sequential(
            nn.Linear(d_model, d_model),
            nn.ReLU(),
            nn.Linear(d_model, 1),
            nn.Tanh(),
        )

    def forward(self, x):
        feats = self.stem(x)  # (B, d, columns, rows)
        # Row-major flatten of (columns, rows): token t is cell
        # (col = t // rows, row = t % rows) = index_from_cell order.
        tokens = feats.flatten(2).transpose(1, 2)  # (B, N, d)
        tokens = tokens + build_position_table(
            self.col_embedding, self.row_embedding
        )[None]

        global_tok = self.global_token.expand(x.shape[0], -1, -1)
        out = torch.cat([global_tok, tokens], dim=1)
        if self.encoder is not None:
            out = self.encoder(out)
        out = self.final_norm(out)

        wall_logits = self.wall_head(out[:, 1:])  # per-cell tokens
        move_logits = self.move_head(out[:, 0])  # global token
        priors = arrange_policy(wall_logits, move_logits)
        if self.log_output:
            priors = fn.log_softmax(priors, dim=1)
        else:
            priors = fn.softmax(priors, dim=1)

        value = self.value_head(out[:, 0])
        return priors, value

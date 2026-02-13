# Training an AlphaZero-Style AI for my Custom Board Game

> What does it take to build a superhuman AI for a new board game?

I created [wallgame.io](https://wallgame.io), an online board game. It requires at least two players, so I wanted a human-level AI so that anyone could play at any time.

The closest parallels are probably chess and Go. For these games, there's a long history of iterative engine improvements, opening databases, and millions of recorded games to learn from. In our case, we had none of that.

We built an AlphaZero-inspired system from scratch: a neural network trained entirely through self-play, guided by Monte Carlo Tree Search, running on consumer GPU hardware. Then we integrated it into a live web game where anyone can play against it.

This post documents the design so it can serve as a reference for other people wanting to add strong engines to their own games. We'll touch on the architecture, the training journey, the engineering challenges, and takeaways.

### Credits:

- [Thorben](https://github.com/t-troebst) built the C++ engine ([Deep-Wallwars](https://github.com/t-troebst/Deep-Wallwars)) and ran the initial training that produced a superhuman model.
- While Thorben built the AlphaZero engine, I built a more traditional Minimax-based C++ engine ([github](https://github.com/nmamano/wallwars/tree/master/AI)), which can be played against in the [old site](https://wallwars.net). We learned that the AlphaZero engine is much stronger for this game (and I believe for most games). From there, I extended the AlphaZero engine to support new game variants, ran subsequent training experiments, and built the integration layer to connect the engine to the server.
- Claude 4.6 Opus wrote the initial draft of this post.

The game has a [monorepo](https://github.com/nmamano/wallgame) with the [updated engine](https://github.com/nmamano/wallgame/tree/main/deep-wallwars), [ai client](https://github.com/nmamano/wallgame/tree/main/official-custom-bot-client), [server](https://github.com/nmamano/wallgame/tree/main/server), [frontend](https://github.com/nmamano/wallgame/tree/main/frontend), and a [test engine](https://github.com/nmamano/wallgame/tree/main/dummy-engine).

The game also has a build-in-public blog, [nilmamano.com/blog/category/wallgame](https://nilmamano.com/blog/category/wallgame), with development writeups (including this one).

## The Game

The Wall Game is a two-player, turn-based, strategy board game played on a rectangular grid. Each player controls a cat and a mouse, and the goal is to catch the opponent's mouse before they catch yours.

<!-- ![Starting position](https://wallgame.io/starting-position.png) -->

On each turn, you can make 2 actions. Each action can be either moving your cat, moving your mouse, or placing a wall. Cats and mice move to adjacent cells, but walls can be placed anywhere between two cells on the board. The only restriction is that you cannot completely block the opponent's cat from reaching your mouse.

<!-- Image Move Showcase Placeholder -->


You can see games in action in the landing page's game showcase ([wallgame.io](https://wallgame.io)) and find the full rules in [wallgame.io/learn](https://wallgame.io/learn).

### Why Wallwars is Hard for AI

Like chess and Go, decisions like wall placements have long-term consequences. Placing a wall in move 5 might not matter until move 25, when it blocks a critical escape route. This makes it difficult to write a good handcrafted evaluation function - the kind of approach that powered chess engines for decades.

But what really "killed" my [Minimax engine](https://github.com/nmamano/wallwars/tree/master/AI) is the branching factor. On an `RxC` board, there are about `2*R*C` walls. And you have *two* actions per turn, so the number of possible wall moves is about the square of that. I came up with [clever optimizations](https://nilmamano.com/blog/double-edge-cut-problem), but it just won't scale.

In contrast, our AlphaZero-based engine is superhuman for `8x8` boards, so it handles branching factors of approximately `(2*8*8)^2 = 16384`. We are now training engines for boards of size up to `10x12`. Chess has an average branching factor of about `40`.

This is exactly the kind of problem where Monte Carlo Tree Search (MCTS) with a learned evaluation function through self-play shines.

## The AlphaZero Recipe

In 2017, DeepMind's AlphaZero showed a different path to the established Minimax approach. Instead of hand-engineering the evaluation function, AlphaZero trains a neural network to learn it from scratch. The network starts knowing nothing about the game except the rules. It improves by playing against itself, thousands of times, gradually learning on its own.

It's this flexibility that makes the recipe plug-and-play for new games.

The system has three core components that work together in a loop:

### Monte Carlo Tree Search (MCTS)

MCTS is the search algorithm. Given a board position, it repeatedly explores possible future moves while building a search tree. At each node, it must decide which move to explore next. This is where the neural network comes in: MCTS uses the network's predictions to focus on the most promising moves rather than searching blindly. After exploring enough positions, MCTS picks the move with the most supporting evidence.

Callout Box Start:

AlphaZero's search has to answer a key question: among the possible moves, how much time should it spend exploring each? Should it focus on the best moves found so far, ensuring they're good (exploitation), or look for alternative moves that seem unpromising but could turn out to be good (exploration)? 

AlphaZero uses an elegant solution known as Upper Confidence Bound (UCB). Suppose you have to choose among several options. For each option, you need to know two things: the expected payoff and the expected variance. The option with the highest expected payoff maximizes exploitation, while the option with the most variance maximizes exploration. To balance the two, the key is to pick the option with the highest expected payoff one standard deviation above the mean.

Callout Box End

### The Neural Network

The neural network takes a board position as input and produces two outputs:

1. **A policy**: a probability distribution over all legal moves, representing how promising each one looks.
2. **An evaluation**: a single number between -1 and +1, estimating who's winning.

The policy guides MCTS toward promising moves. The evaluation replaces the classic handcrafted evaluation function. Together, they guide MCTS so that the search time doesn't blow up with the branching factor.

### The Self-Play Training Loop

We start with a random neural network (more on the model architecture later). Then, we train it in generations. I'll use some numbers from one of our training runs.

- Each generation is 4000 self-play games.
- Each game lasts around 40 moves (80 'plies' or turns).
- Each player must take 2 actions per turn.
- For each action, we collect 1200 MCTS samples.
- Each sample plays the game forward until it reaches a new position, which is then evaluated with a model inference to get the policy and evaluation.

That comes out to about `80 * 2 * 1200 = 192k` inferences per game, for a total of `4000 * 192k = 768M` inferences per generation. There's a sharded LRU cache reducing the number of inferences a bit, but the key optimization that makes this possible is batching (more on that later).

After each game, the moves chosen by MCTS and the game outcome become training data for the network. The network learns to predict which moves MCTS would choose (policy) and who won (value).

The idea is that the model slowly converges to the same policy and evaluation computed by MCTS, so that a single model evaluation is as good as 1200 MCTS samples.

After each generation, we train the network on the accumulated training data. Then the updated network is used for the next round of self-play, producing better training data, which produces a better network, and so on.

For the first few generations, we used a simple policy to bootstrap the training data. In the simple policy, the cats simply walked toward the goal, and we also placed walls randomly (so that the model would be aware of walls).

<!-- [Diagram placeholder: the self-play loop - circular diagram showing: Self-Play (MCTS + NN) → Game Data → Train Neural Network → Updated NN → back to Self-Play] -->

## Our Neural Network

Our network follows the same architecture as AlphaZero. It has a ResNet core, with 20 residual blocks with 128 hidden channels, for a total of about 2.3 million parameters. Small by modern deep learning standards, but large enough to capture the strategic complexity of an 8x8 board game.

ResNet was originally designed for image classification. It uses convolutions to extract local features from an image. This works well for board games like chess or the Wall Game because (1) the board is a grid, like an image, and (2) local features are also important, like clusters of adjacent walls blocking a path.

### Input Encoding

The network sees the board as 9 "planes" (like color channels in an image), each the size of the board grid:

| Plane | What it Represents |
|-------|-------------------|
| 0 | Distance from your pawn to every cell |
| 1 | Distance from your goal to every cell |
| 2 | Distance from opponent's pawn to every cell |
| 3 | Distance from opponent's goal to every cell |
| 4 | Vertical walls (which right-edges are blocked) |
| 5 | Horizontal walls (which bottom-edges are blocked) |
| 6 | Is this the second action of the turn? |
| 7 | Is the current player Red? |
| 8 | Variant indicator (1 for Standard, 0 for Classic) |

A key design choice here is using *relative distances* rather than raw positions for the first four planes. Instead of a single "1" at the pawn's location, every cell gets a value representing how far it is from the pawn (computed via BFS through the current wall layout). This encoding is more informative - the network immediately "sees" how the wall structure affects reachability - and it generalizes better across board positions.

The game has two main variants:

- **Classic**: Each player's pawn starts in one corner and races to the diagonally opposite corner. Clean, symmetric, pure.
- **Standard**: Each player controls a cat and a mouse. Your cat chases your opponent's mouse, which your opponent can move to evade. This creates an asymmetric dynamic - you're simultaneously attacking and defending.

### Output Heads

The network has two output heads branching from the shared ResNet body:

**Policy head**: Outputs a probability for each possible action - one for each wall placement (2 × cols × rows, covering vertical and horizontal walls) plus pawn moves (4 directions for the cat, 4 more for the mouse in Standard variant). This goes through a softmax so all probabilities sum to 1.

**Value head**: Outputs a single number passed through tanh, giving a value in [-1, +1]. Positive means the current player is winning; negative means they're losing.

### Training Loss

The loss function has two parts:

- **KL divergence** between the network's policy output and MCTS's move probabilities (derived from visit counts in the search tree). This teaches the network to predict which moves MCTS would choose.
- **Mean squared error** between the network's value output and the actual game outcome. This teaches the network to predict who wins.

### Pseudocode

Here's a simplified view of the architecture:

```
ResNet(input: 9 × rows × cols):
    x = Conv2d(9 → 128, 3×3) → BatchNorm → ReLU

    for each of 20 residual blocks:
        residual = x
        x = Conv2d(128 → 128, 3×3) → BatchNorm → ReLU
        x = Conv2d(128 → 128, 3×3) → BatchNorm
        x = ReLU(x + residual)      ← skip connection

    policy = Conv2d(128 → 32, 3×3) → BatchNorm → ReLU → Flatten
           → Linear(32·rows·cols → 2·rows·cols + move_channels) → Softmax

    value = Conv2d(128 → 32, 3×3) → BatchNorm → ReLU → Flatten
          → Linear(32·rows·cols → 1) → Tanh

    return policy, value
```

The skip connections in the residual blocks are critical - they allow gradients to flow through the network during training, making it possible to train 20+ layers deep without degradation.

## Making MCTS Fast: Coroutines and Batched GPU Inference

The self-play training loop is the performance bottleneck of the entire system. To train a strong model, we need to generate hundreds of thousands of self-play games, each requiring thousands of MCTS iterations. Every MCTS iteration involves a neural network evaluation. Doing this naively would be painfully slow.

### The GPU Utilization Problem

Modern GPUs are massively parallel processors - they're fast when processing large batches of data, but terribly inefficient when processing one item at a time. A single neural network evaluation on an RTX 4090 takes nearly as long as evaluating a batch of 256 positions, because most of the GPU's compute units sit idle with a single input.

The problem is that standard MCTS is inherently sequential: you traverse the tree, reach a leaf, evaluate it with the neural network, backpropagate the result, then repeat. Each iteration depends on the result of the previous one (because the tree changes after each backpropagation). So naively, you'd evaluate one position at a time, and your expensive GPU would be utilized at roughly 1% capacity.

### The Solution: Coroutine-Based Parallelism

Our approach uses C++ coroutines (via Facebook's Folly library) to decouple MCTS traversal from neural network evaluation.

Here's the idea: instead of running one MCTS iteration at a time, we run many in parallel. Each iteration is a coroutine - a lightweight function that can suspend and resume. When a coroutine reaches a leaf node and needs a neural network evaluation, it doesn't block. Instead, it submits its request to a shared queue and *suspends*, freeing its thread to work on other iterations.

A dedicated batch worker thread monitors the queue. When enough requests accumulate (or a short timeout expires), it collects them into a batch - typically 256 positions - and sends the entire batch to the GPU in a single call via TensorRT (NVIDIA's optimized inference runtime). When the GPU returns results, each waiting coroutine is resumed with its specific result.

```
Thread Pool (20+ CPU threads)
    │
    ├── MCTS Coroutine 1: traverse tree → reach leaf → [suspend, enqueue request]
    ├── MCTS Coroutine 2: traverse tree → reach leaf → [suspend, enqueue request]
    ├── MCTS Coroutine 3: backpropagating result (resumed)
    ├── ...
    │
    ▼
Lock-Free Queue (Folly MPMC)
    │
    ▼
Batch Worker Thread
    │ collects 256 requests
    ▼
GPU (TensorRT)
    │ returns 256 results
    ▼
Resume suspended coroutines with results
```

<!-- [Diagram placeholder: coroutine batching diagram - multiple MCTS threads → lock-free queue → batch worker → GPU → results fan out back to coroutines] -->

This design keeps both the CPU and GPU busy simultaneously. Twenty-plus CPU threads are constantly traversing trees and backpropagating results, while the GPU processes large batches of neural network evaluations. The lock-free MPMC (Multi-Producer Multi-Consumer) queue from Folly handles the handoff between CPU and GPU without expensive synchronization.

### Key MCTS Parameters

A few parameters govern how MCTS explores the game tree:

- **PUCT constant (2.0)**: Controls the exploration-exploitation tradeoff. Higher values make MCTS explore more broadly; lower values make it focus on the most promising moves.
- **Dirichlet noise (α=0.3, factor=0.25)**: Random noise added to the root node's prior probabilities. This ensures self-play games explore diverse strategies rather than always playing the same opening.
- **Max parallelism (4)**: How many MCTS iterations can run concurrently for a single game session. Too many and they interfere with each other (exploring redundant branches); too few and the GPU goes hungry.

### Performance

With this architecture, we can generate thousands of self-play games per hour on a single consumer GPU (RTX 4090 or RTX 5080). The entire 8x8 Classic training run - 750,000 games - took about 100 hours. Without batched inference, it would have taken orders of magnitude longer.

## The Training Journey

### Proof of Concept: 5×5 Classic

We started small. A 5×5 board has a fraction of the state space of 8×8, so training is fast - a good environment for validating that the pipeline works end-to-end before investing serious compute.

We generated 60,000 self-play games on 5×5 and trained the network for several generations. Even on this tiny board, the results were encouraging. The model learned non-trivial wall placement strategies: it would build walls to lengthen its opponent's path while keeping its own path clear, and it learned to anticipate wall placements several moves ahead.

More importantly, this phase caught several bugs in the data pipeline, coordinate transforms, and training loop that would have been much more expensive to debug on a larger board.

### The Real Thing: 8×8 Classic

With the pipeline validated, we scaled to the full 8x8 board. This is where things got serious.

**Training setup:**
- **Games per generation**: 5,000
- **MCTS samples per action**: 1,200
- **Training window**: last 20 generations (~100,000 most recent games)
- **Batch size**: 512
- **Hardware**: NVIDIA RTX 5080
- **Total training time**: ~100 hours

The first generation used a simple heuristic policy (walk toward goal, place walls randomly) instead of the neural network, to bootstrap initial training data. Starting from random network weights with random self-play would produce games that meander aimlessly - the signal-to-noise ratio would be too low for the network to learn anything useful. The heuristic bootstrap gives the network a foundation: "moving toward your goal is good."

From generation 2 onward, each generation follows the self-play loop: play 5,000 games using MCTS guided by the current network, train the network on the accumulated data, export the updated model, repeat.

<!-- [Diagram placeholder: Elo progression chart showing strength over generations for 8×8 Classic] -->

The model's strength (measured in Elo by playing different generations against each other) grew rapidly in the first 20 generations, then steadily improved through 150+ generations. The early gains come from learning basic strategy: move toward your goal, block your opponent's path. The later improvements are subtler: sacrificing short-term progress for a stronger wall structure, creating "traps" where the opponent's path forks into two equally bad options, and timing wall placements to maximize their impact.

After 750,000 self-play games, the result is a superhuman player - stronger than any human we've tested it against. It plays with a style that's recognizably strategic but often surprising, finding wall placements that look odd at first but turn out to be deeply calculated.

### New Variant: 8×8 Standard

With a strong Classic model in hand, we turned to Standard - the variant where each player also controls a mouse that their opponent's cat chases. Standard has 8 pawn-move channels (4 for the cat, 4 for the mouse) instead of Classic's 4, and the strategic landscape is richer because of the cat-and-mouse dynamics.

Rather than training from scratch, we warm-started from the Classic model. The idea was that wall placement patterns, spatial reasoning, and basic strategy transfer between variants - only the mouse-handling needs to be learned from scratch.

This mostly worked, but we hit a cold-start problem: **the model never moved its mouse.** Classic doesn't have mice, so the warm-started model's mouse-move probabilities were essentially random noise. MCTS, guided by the policy head, would never select mouse moves because their priors were so low relative to cat moves and wall placements. And since MCTS never explored mouse moves, the training data never contained them, so the network never learned that moving mice is valuable. A vicious cycle.

Our fix was pragmatic: for a few generations, we directly boosted the mouse-move probabilities in the MCTS policy, forcing the search to explore mouse moves even though the network said they were unlikely. This gave the training data enough mouse-move examples for the network to start learning their value. After a few generations of boosted exploration, the network had learned that mouse moves matter, and we removed the boost.

The resulting model is strong - it plays both variants competently - but not quite as strong as the pure Classic model. Partly this is because Standard is a harder game with a larger action space, and partly because we invested less training compute.

### The Universal Model

Our most ambitious training experiment (still in progress) is the universal model: a single network that plays both Classic and Standard on larger boards (12×10).

This required several innovations:

**Spatial remapping for warm-start:** The universal model's 12×10 board is larger than the 8×8 Standard model we're warm-starting from. Convolutional layers transfer directly (they're translation-invariant), but the Linear layers in the policy and value heads are tied to specific board positions. We spatially embed the 8×8 weights within the 12×10 grid, centering them with an offset of (col=2, row=1), and randomly initialize the weights for the new boundary positions.

**Progressive unfreezing:** After warm-starting, we freeze the convolutional body for the first few generations, only training the Linear head layers. This prevents catastrophic forgetting - without freezing, the high loss from the randomly-initialized boundary weights would generate large gradients that destroy the valuable features learned on 8×8.

**Half-and-half self-play:** Each generation plays half its games as Classic and half as Standard. The variant indicator (input plane 8) tells the network which variant it's playing. This ensures the model learns to use that signal from the start.

The universal model is a work in progress. It plays both variants, but sometimes makes nonsensical moves - a sign that it needs significantly more training compute to match the quality of the dedicated 8×8 Classic model. Training is ongoing.

## Serving Moves in a Live Web Game

Training a strong model is only half the challenge. The other half is making it play games against real people, in real time, in a web browser.

### The Integration Challenge

The architecture involves three separate systems that need to communicate:

1. **The game server** - a Hono/Bun application running on Fly.io, handling game logic, matchmaking, and WebSocket connections to browser clients. No GPU.
2. **The bot client** - a TypeScript process running on a Linux machine with an NVIDIA GPU. Manages the connection between the server and the engine.
3. **The engine** - the C++ Deep-Wallwars binary, running on the same GPU machine. Loads models into GPU memory, maintains MCTS trees, and evaluates positions.

<!-- [Diagram placeholder: integration architecture - Browser (React) ↔ WebSocket ↔ Game Server (Fly.io, Hono/Bun) ↔ WebSocket ↔ Bot Client (TypeScript, GPU machine) ↔ stdin/stdout JSON-lines ↔ Deep-Wallwars Engine (C++, TensorRT)] -->

On top of serving bot moves, the system also powers an **eval bar** - a live position evaluation display (like the ones you see on chess streaming sites) that any player or spectator can toggle during a game.

### The Protocol Evolution

Getting the communication protocol right took three iterations.

**V1 (Seat-based):** Our first attempt was simple: for each move request, spawn a fresh engine process, pipe in a JSON request via stdin, read the response from stdout, kill the process. This works, but it's terrible for performance. Loading a TensorRT model into GPU memory takes several seconds - longer than the actual computation. And since the process dies after each move, there's no way to reuse the MCTS tree between turns.

**V2 (Proactive):** We improved the networking by having the bot client connect proactively to the server (instead of the server spawning connections per game). But the engine was still stateless - invoked as a CLI command for each decision. Better networking, same performance problem.

**V3 (Bot Game Sessions):** The breakthrough was making the engine a long-lived process. It starts once, loads all models into GPU memory once, and then handles requests over a JSON-lines protocol (one JSON object per line on stdin/stdout).

The key concept in V3 is the **Bot Game Session (BGS)**: a stateful context for one game, with its own MCTS tree. When a game starts, the server sends `start_game_session`. The engine creates a new MCTS tree. When the server needs a move, it sends `evaluate_position`, and the engine runs MCTS against its existing tree and returns a move and evaluation. When the opponent plays, `apply_move` updates the tree - and critically, *prunes* it: the subtree rooted at the played move becomes the new root, preserving all the search work that's still relevant. When the game ends, `end_game_session` cleans up.

Multiple BGSs run concurrently (up to 256), sharing the GPU through the same batched inference pipeline used during training. The `expectedPly` field in each request prevents race conditions - if a stale evaluation request arrives after a move has already been applied, the ply mismatch catches it.

### The Bot Client

The bot client is the middleware that ties everything together. It's a TypeScript process running on the GPU machine alongside the engine, with these responsibilities:

- **WebSocket management**: Maintains a persistent connection to the game server with automatic reconnection (exponential backoff with jitter). On startup, it sends an `attach` message registering which bots are available, what variants they support, and what board sizes they can play.
- **Engine lifecycle**: Spawns the engine process on startup and keeps it running. If the WebSocket disconnects and reconnects, the engine stays alive - all active game sessions continue seamlessly without any interruption from the engine's perspective.
- **Session multiplexing**: Routes BGS messages between the server and the engine, multiplexing multiple concurrent game sessions over a single engine process.

The bot client is configured via a JSON file that specifies the bot's name, appearance (avatar, colors), supported variants and board sizes, and the command to launch the engine binary.

### The Eval Bar

One of the more interesting integration challenges was the eval bar - a live display showing the engine's position evaluation for every move in the game, similar to what you'd see on a chess broadcast.

The server maintains a **BGS history**: an evaluation and best move for every position from the start of the game. When a player or spectator toggles the eval bar, the server streams this entire history to the frontend, giving them instant evaluations for the full move history.

If the eval bar is toggled on mid-game (say, at move 15), the server replays all 15 moves through the engine - sending `evaluate_position` and `apply_move` for each one - to build the complete history before streaming it. This replay is invisible to the user; they just see evaluations appear.

The eval bar works for bot games, human-vs-human games (unrated), spectators, and even past game replays. Takebacks are handled by ending the current BGS, starting a fresh one, and replaying moves up to the new position. All of this complexity is hidden from the engine - it just sees the same four message types.

### Board Padding: One Model, Many Board Sizes

Models are trained for a specific board size (e.g., 8×8), but the game supports smaller boards too. Rather than training separate models for every board size, we embed smaller boards inside the model's fixed grid using **padding walls**.

For example, to play on a 6×6 board with an 8×8 model, we place the 6×6 game area inside the 8×8 grid and surround the unused border cells with walls. The engine sees an 8×8 board where some areas happen to be walled off. From the model's perspective, the padding walls are just more walls - there's nothing special about them.

<!-- [Diagram placeholder: padding example - 6×6 board embedded in 8×8 grid, showing padding walls and the playable area] -->

The key question was whether this actually works. A model trained exclusively on 8×8 boards has never seen a position with this specific wall pattern (walls forming a complete border around the playable area). Would it play well?

The answer is yes, and the reason is that convolutional neural networks are translation-invariant. The model learns local patterns - "if there's a wall here and the opponent is there, blocking this way is good" - and these patterns apply regardless of where they appear on the grid. The padding walls are just more data for the model to reason about.

Different variants require different padding strategies. In Classic, where goals are in the corners, we embed the smaller board at the bottom-center of the grid to maintain path structure to the goal corners. In Standard, we embed at the top-left. This lets a single 8×8 model serve boards from 4×4 to 8×8 without any retraining.

## Lessons Learned and What's Next

### Lessons Learned

**Start small, scale up.** Our 5×5 proof of concept caught bugs in coordinate transforms, data loading, and the training loop. Fixing these on 5×5 (where a full training run takes minutes) saved us from expensive debugging on 8×8 (where a full run takes days). If you're building a similar system, resist the urge to go straight to your target configuration.

**Warm-starting is powerful but demands care.** Transferring learned weights between board sizes and game variants dramatically reduces training time, but it introduces new failure modes. Without progressive unfreezing, catastrophic forgetting destroyed valuable features. Without careful initialization of new boundary weights, the model couldn't learn to use new board regions. Each of these required specific engineering solutions.

**Cold-start problems are real.** When warm-starting the Standard model from Classic, the model had zero experience with mouse moves. Since the policy head gave mouse moves near-zero probability, MCTS never explored them, and the training data never contained them. We had to break this cycle manually by boosting mouse-move probabilities for a few generations. This felt like a hack, but it was the pragmatic solution to a real bootstrapping problem.

**Engineering matters as much as ML.** The coroutine-based batched inference system is what made training feasible on consumer hardware. Without it, GPU utilization would have been negligible, and the 750,000-game training run would have taken months instead of days. Similarly, TensorRT compilation (converting ONNX models to optimized GPU code) roughly doubled inference throughput compared to running the PyTorch model directly.

**The integration is its own project.** Connecting a C++ engine to a web game via WebSocket required three protocol iterations and a dedicated bot client layer. The eval bar system, with its move replay, BGS history management, and multi-client streaming, was more complex than we expected. None of this is ML work - it's distributed systems engineering - but it's what turns a trained model into a product.

### What's Next

**Universal model:** Our current 12×10 universal model can play both Classic and Standard, but it sometimes makes nonsensical moves. It needs significantly more training compute - likely millions more self-play games - to match the quality of the dedicated 8×8 Classic model. This is our top priority.

**Stronger inference:** During live games, the engine uses about 1,000 MCTS samples per move. More samples mean stronger play but slower responses. We're exploring ways to make the engine think longer on critical positions while responding quickly on obvious ones.

**Puzzles:** The engine can evaluate any position and identify the best move. We plan to use this to generate tactical puzzles: positions where there's one clearly best move, and all alternatives are significantly worse. These would be integrated into the game as a training mode for players.

## Try It Yourself

Play against the AI at [wallgame.io](https://wallgame.io). Start with a smaller board if you're new - the AI is forgiving on 5×5 or 6×6, but quite strong on 8×8.

Explore the code:

- **[Deep-Wallwars](https://github.com/t-troebst/Deep-Wallwars)** - Thorben's original C++ engine: MCTS, neural network inference, self-play, and training pipeline
- **[Wallgame](https://github.com/nmamano/wallgame)** - the full game: React frontend, Hono backend, bot client integration, and the vendored (and extended) engine

For further reading on the techniques behind this project, the original [AlphaZero paper](https://arxiv.org/abs/1712.01815) by Silver et al. (2017) is remarkably readable and covers the foundational ideas we built on.

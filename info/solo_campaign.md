# Solo Campaign,

## Layout for the first levels

The layout is:

An info box at the top, and a board panel below it. That's it. The two should have the same width.

### The info panel

- has sound effects and music toggles.
- has a reset level button.
- has text explaining the level. It's level-specific.

### Board panel

It shows a level-specific game position. The user plays as one of the sides.

- Action staging, premoving, annotatin, etc., works as usual.
- Pawn move arrows work as usual.

### Ending

When the game ends or a certain condition is reached, a popup appears over the info panel (not the board) with the following text:

- If the player won: "You won! You can continue to the **next level**, **try again**, or go back to the **main menu**."
- If the player lost: "You lost. You can **try again**, or go back to the **main menu**."

In the text, **next level**, **try again**, and **main menu** are clickable.

### Backend

- If the user is logged in, the client sends a message to the server indicating that the current level has been completed. This is stored to DB.
- If the user is not logged in, nothing is saved.
- In the Solo Campaign page, show a text: "Create an account to save your progress."

## First level

Info text:

"You are the **red cat**. Your goal is to catch the **blue mouse**. Try moving toward it. If it gets away, block it with walls.

You can make two steps at once, make one step and place one wall, or place two walls.

Turns remaining: **10**"

- The turns remaining counter goes down by 1 each time the red cat moves.
- In the text, red cat is in color red and blue mouse is in color blue.

### board

- user is red, AI is blue
- Survival variant
  - 6x6
  - a square of premade (gray) walls surrounding the central 2x2 square
  - red cat starts in the top left corner
  - blue mouse starts in the bottom right corner
  - red cat moves first
  - turns to survive: 10

### AI

- When the player moves, the mouse will move following a simple AI: among all reachable cells 2 steps away, move to the one furthest away from the cat. In case of a tie, pick randomly. Wait 1s before moving.
- This AI runs on the frontend, not server. It's similar to the existing dummy AI move.

## Second level

Info panel text:

"You are the **red mouse**. In this level, you cannot move. Your goal is to survive 4 turns by placing walls to delay the **blue cat**. You can place two walls per turn, but you can't completely block the cat.

Turns remaining: **4**"

- **red mouse** is in color red and **blue cat** is in color blue.
- The turns remaining counter goes down by 1 each time the blue cat moves.

### Board

- user is red, AI is blue
- The blue cat moves first.
- Survival variant
  - 3x5 
  - blue cat starts at a2.
  - red mouse starts at e2.
  - The red mouse cannot be moved.

### AI

- The blue cat follows the dummy AI: among all reachable cells 2 steps away, move to the one closest to the red mouse. In case of a tie, pick randomly. Wait 1s before moving.

## Third level

This will come later. For now, just leave the existing placeholders.

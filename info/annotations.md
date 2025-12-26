I want to add a client-side feature: board annotations

Annotations have no gameplay impact in any way. It is just to help with visualizations.

1. Rightclicking a cell on the board highlights it with a circle. Rightclicking it again removes the highlight.
2. Rightclicking a walls slot (empty or not) highlights it with a line running along the wall, centered inside it. Rightclicking it again removes the highlight.
3. Rightclicking a cell and then doing a dragging motion to another cell draws an arrow between the cells. Doing the dragging motion again removes the arrow.

Rules:
- Annotations cannot be done on touch screen devices.
- There is no limit to annotations.
- Annotations are cleared whenever the user commits an actual move.
- Annotations should be colored such that they cannot be confused with premoves, staged actions, or actual walls.

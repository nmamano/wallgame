"use client"

import type React from "react"

import { Cat } from "lucide-react"

export default function IconGrid() {
  // Settings
  const showMovementArrows = false // Set to false to hide arrows

  // Create a 10x10 grid array
  const grid = Array.from({ length: 10 }, (_, rowIndex) =>
    Array.from({ length: 10 }, (_, colIndex) => ({ row: rowIndex, col: colIndex })),
  )

  // Define positions for pieces and their movement indicators
  const pieces = {
    redCat: { row: 0, col: 0 }, // Top-left: Red cat
    blueCat: { row: 0, col: 9 }, // Top-right: Blue cat
    greenCat: { row: 9, col: 0 }, // Bottom-left: Green cat
    purpleCat: { row: 9, col: 9 }, // Bottom-right: Purple cat
  }

  // Define walls between cells - empty array to remove existing walls
  // Format: [row1, col1, row2, col2] representing a wall between (row1,col1) and (row2,col2)
  const walls = [
    // Empty array - no walls
  ]

  // Check if there's a wall between two cells
  const hasWall = (row1: number, col1: number, row2: number, col2: number) => {
    return walls.some(
      ([r1, c1, r2, c2]) =>
        (r1 === row1 && c1 === col1 && r2 === row2 && c2 === col2) ||
        (r1 === row2 && c1 === col2 && r2 === row1 && c2 === col1),
    )
  }

  return (
    <div className="p-8">
      <div className="border-4 border-gray-800 rounded-lg p-2 bg-amber-100 w-full max-w-4xl mx-auto">
        <div className="grid grid-cols-10 gap-1 w-full relative">
          {/* Render the walls */}
          {walls.map(([row1, col1, row2, col2], index) => {
            // Calculate position for the wall
            const isHorizontal = row1 === row2
            const cellSize = "calc((100% - 9 * 0.25rem) / 10)" // Approximate cell size based on grid

            let style: React.CSSProperties = {
              position: "absolute",
              backgroundColor: "#dc2626", // Red color matching the red cat
              zIndex: 10,
            }

            if (isHorizontal) {
              // Horizontal wall (between cells in the same row)
              const minCol = Math.min(col1, col2)
              style = {
                ...style,
                height: "0.5rem",
                width: "calc(100% / 10 + 0.25rem)", // Cell width + gap
                // Adjusted to be perfectly centered between rows
                top: `calc(${row1} * (${cellSize} + 0.25rem) - 0.125rem)`, // Move up slightly
                left: `calc(${minCol} * (${cellSize} + 0.25rem) - 0.125rem)`, // Adjusted left position
                transform: "translateY(-50%)", // Center vertically
              }
            } else {
              // Vertical wall (between cells in the same column)
              const minRow = Math.min(row1, row2)
              style = {
                ...style,
                width: "0.5rem",
                height: "calc(100% / 10 + 0.25rem)", // Cell height + gap
                // Adjusted to be perfectly centered between columns
                left: `calc(${col1} * (${cellSize} + 0.25rem) - 0.125rem)`, // Move left slightly
                top: `calc(${minRow} * (${cellSize} + 0.25rem) - 0.125rem)`, // Adjusted top position
                transform: "translateX(-50%)", // Center horizontally
              }
            }

            return <div key={`wall-${index}`} style={style} className="shadow-md rounded-full" />
          })}

          {grid.map((row, rowIndex) =>
            row.map(({ col: colIndex }) => {
              const isRedCatCell = rowIndex === pieces.redCat.row && colIndex === pieces.redCat.col
              const isBlueCatCell = rowIndex === pieces.blueCat.row && colIndex === pieces.blueCat.col
              const isGreenCatCell = rowIndex === pieces.greenCat.row && colIndex === pieces.greenCat.col
              const isPurpleCatCell = rowIndex === pieces.purpleCat.row && colIndex === pieces.purpleCat.col

              return (
                <div
                  key={`${rowIndex}-${colIndex}`}
                  className={`aspect-square border border-amber-400 flex items-center justify-center ${
                    (rowIndex + colIndex) % 2 === 0 ? "bg-amber-200" : "bg-amber-100"
                  }`}
                >
                  {/* Red cat - Top Left */}
                  {isRedCatCell && (
                    <div className="w-full h-full flex items-center justify-center p-1">
                      <Cat
                        size={36}
                        strokeWidth={2.5}
                        className="text-red-600 w-full h-full transform hover:scale-110 transition-transform"
                      />
                    </div>
                  )}

                  {/* Blue cat - Top Right */}
                  {isBlueCatCell && (
                    <div className="w-full h-full flex items-center justify-center p-1">
                      <Cat
                        size={36}
                        strokeWidth={2.5}
                        className="text-blue-600 w-full h-full transform hover:scale-110 transition-transform"
                      />
                    </div>
                  )}

                  {/* Green cat - Bottom Left */}
                  {isGreenCatCell && (
                    <div className="w-full h-full flex items-center justify-center p-1">
                      <Cat
                        size={36}
                        strokeWidth={2.5}
                        className="text-green-600 w-full h-full transform hover:scale-110 transition-transform"
                      />
                    </div>
                  )}

                  {/* Purple cat - Bottom Right */}
                  {isPurpleCatCell && (
                    <div className="w-full h-full flex items-center justify-center p-1">
                      <Cat
                        size={36}
                        strokeWidth={2.5}
                        className="text-purple-600 w-full h-full transform hover:scale-110 transition-transform"
                      />
                    </div>
                  )}
                </div>
              )
            }),
          )}
        </div>
      </div>
    </div>
  )
}

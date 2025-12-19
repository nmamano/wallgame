export interface HistoryNav {
  cursor: number | null;
  latestPlyIndex: number | null;
  canStepBack: boolean;
  canStepForward: boolean;
  stepBack: () => void;
  stepForward: () => void;
  jumpStart: () => void;
  jumpEnd: () => void;
  goTo: (plyIndex: number) => void;
}

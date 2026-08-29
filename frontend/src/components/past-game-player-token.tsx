/** @jsxImportSource react */
import type { ReactNode } from "react";
import type { PastGamePlayerKind } from "../../../shared/contracts/games";

const identityPresentation = {
  guest: {
    label: "Guest",
    className: "text-slate-700 dark:text-slate-300",
  },
  bot: {
    label: "Bot",
    className: "text-violet-700 dark:text-violet-300",
  },
  member: {
    label: "Member",
    className: "text-sky-700 dark:text-sky-300",
  },
} satisfies Record<PastGamePlayerKind, { label: string; className: string }>;

export function PastGamePlayerToken({
  kind,
  children,
}: {
  kind: PastGamePlayerKind;
  children: ReactNode;
}) {
  const { label, className } = identityPresentation[kind];

  return (
    <span data-player-kind={kind} className={className}>
      <span className="sr-only">{label}: </span>
      {children}
    </span>
  );
}

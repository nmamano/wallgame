import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { resolvePawnBackingSrc } from "@/lib/pawn-style";
import { resolvePawnForegroundFixSrc } from "@/lib/pawn-foreground-fix";

interface PawnImageProps {
  src: string;
  alt: string;
  className?: string;
  imageClassName?: string;
  imageStyle?: CSSProperties;
  draggable?: boolean;
  loading?: "eager" | "lazy";
}

export function PawnImage({
  src,
  alt,
  className,
  imageClassName,
  imageStyle,
  draggable,
  loading,
}: PawnImageProps) {
  const backingSrc = resolvePawnBackingSrc(src);
  const foregroundFixSrc = resolvePawnForegroundFixSrc(src);

  if (!backingSrc) {
    return (
      <img
        src={src}
        alt={alt}
        className={cn(
          "h-full w-full object-contain",
          className,
          imageClassName,
        )}
        style={imageStyle}
        draggable={draggable}
        loading={loading}
      />
    );
  }

  return (
    <span className={cn("relative block", className)}>
      <img
        src={backingSrc}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="absolute inset-0 h-full w-full object-contain"
      />
      <img
        src={src}
        alt={alt}
        className={cn(
          "absolute inset-0 h-full w-full object-contain",
          imageClassName,
        )}
        style={imageStyle}
        draggable={draggable}
        loading={loading}
      />
      {foregroundFixSrc && (
        <img
          src={foregroundFixSrc}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          style={imageStyle}
        />
      )}
    </span>
  );
}

// svg-path-bounds ships no types and has no @types package.
//
// Left untyped, its return value is `any`, and every number derived from it is
// too - one missing declaration produced five no-unsafe-* lint errors in
// normalize-icons.ts on top of the TS7016. Hence a real signature rather than
// a bare `declare module`, which would have silenced tsc and left the lint
// errors exactly where they were.
//
// The tuple order is [minX, minY, maxX, maxY]: the implementation seeds
// `bounds` with [Infinity, Infinity, -Infinity, -Infinity] and fills index 0/1
// from the minimum x/y and 2/3 from the maximum.
declare module "svg-path-bounds" {
  export default function pathBounds(
    path: string,
  ): [number, number, number, number];
}

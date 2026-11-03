import { z } from "zod";

/**
 * An array schema that refuses more than `max` elements BEFORE it parses any
 * element. `z.array(element).max(max)` parses every element first and checks
 * the length after, so an over-long array costs work in proportion to its
 * length. Use this for every array a client sends.
 */
export const boundedArray = <T extends z.ZodType>(element: T, max: number) =>
  z.array(z.unknown()).max(max).pipe(z.array(element));

/**
 * Shared type definitions.
 */

export interface Disposable {
  dispose(): void;
}

export type TypedArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array;

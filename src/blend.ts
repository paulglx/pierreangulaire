export const BlendMode = { MIP: 0, MinIP: 1, Average: 2, Composite: 3 } as const;
export type BlendMode = (typeof BlendMode)[keyof typeof BlendMode];

export interface WindowLevel {
  center: number;
  width: number;
}

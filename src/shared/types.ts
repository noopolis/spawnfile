export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonObject | JsonPrimitive | JsonValue[];
export type RuntimeLifecycleStatus = "active" | "deprecated" | "exploratory";

export interface JsonObject {
  [key: string]: JsonValue;
}

export type StringMap = Record<string, string>;

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonObject | JsonPrimitive | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type StringMap = Record<string, string>;

/**
 * 参数验证工具
 * 用于验证工具参数的类型和必需性，替代大量的 `as` 类型断言
 */

export type ParamType = "string" | "number" | "boolean" | "array" | "object";

export interface ParamSpec {
  type: ParamType;
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  validate?: (value: unknown) => boolean;
}

export interface ParamSchema {
  [key: string]: ParamSpec;
}

/**
 * 验证并提取参数
 * @param args 原始参数对象
 * @param schema 参数规范
 * @returns 验证后的参数对象
 * @throws Error 如果参数验证失败
 */
export function validateArgs<T>(
  args: unknown,
  schema: ParamSchema
): T {
  if (args === null || args === undefined) {
    throw new Error("参数不能为空");
  }
  if (typeof args !== "object") {
    throw new Error(`参数必须是对象，收到: ${typeof args}`);
  }

  const result: Record<string, unknown> = {};
  const inputArgs = args as Record<string, unknown>;

  for (const [key, spec] of Object.entries(schema)) {
    const value = inputArgs[key];

    // 处理必需参数
    if (spec.required && (value === undefined || value === null)) {
      throw new Error(`参数 "${key}" 是必需的`);
    }

    // 使用默认值
    if ((value === undefined || value === null) && spec.default !== undefined) {
      result[key] = spec.default;
      continue;
    }

    // 可选参数未提供，跳过
    if (value === undefined || value === null) {
      continue;
    }

    // 类型验证
    const actualType = Array.isArray(value) ? "array" : typeof value;
    if (actualType !== spec.type) {
      throw new Error(
        `参数 "${key}" 类型错误: 期望 ${spec.type}, 收到 ${actualType}`
      );
    }

    // 数值范围验证
    if (spec.type === "number" && typeof value === "number") {
      if (spec.min !== undefined && value < spec.min) {
        throw new Error(`参数 "${key}" 必须 >= ${spec.min}, 收到 ${value}`);
      }
      if (spec.max !== undefined && value > spec.max) {
        throw new Error(`参数 "${key}" 必须 <= ${spec.max}, 收到 ${value}`);
      }
    }

    // 自定义验证
    if (spec.validate && !spec.validate(value)) {
      throw new Error(`参数 "${key}" 验证失败`);
    }

    result[key] = value;
  }

  return result as T;
}

/**
 * 验证字符串参数（非空）
 */
export function validateString(value: unknown, paramName: string): string {
  if (value === undefined || value === null) {
    throw new Error(`参数 "${paramName}" 是必需的`);
  }
  if (typeof value !== "string") {
    throw new Error(`参数 "${paramName}" 必须是字符串，收到: ${typeof value}`);
  }
  return value;
}

/**
 * 验证数字参数
 */
export function validateNumber(
  value: unknown,
  paramName: string,
  options?: { min?: number; max?: number; default?: number }
): number {
  if (value === undefined || value === null) {
    if (options?.default !== undefined) {
      return options.default;
    }
    throw new Error(`参数 "${paramName}" 是必需的`);
  }
  if (typeof value !== "number") {
    throw new Error(`参数 "${paramName}" 必须是数字，收到: ${typeof value}`);
  }
  if (options?.min !== undefined && value < options.min) {
    throw new Error(`参数 "${paramName}" 必须 >= ${options.min}, 收到 ${value}`);
  }
  if (options?.max !== undefined && value > options.max) {
    throw new Error(`参数 "${paramName}" 必须 <= ${options.max}, 收到 ${value}`);
  }
  return value;
}

/**
 * 验证布尔参数
 */
export function validateBoolean(
  value: unknown,
  paramName: string,
  defaultValue?: boolean
): boolean {
  if (value === undefined || value === null) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`参数 "${paramName}" 是必需的`);
  }
  if (typeof value !== "boolean") {
    throw new Error(`参数 "${paramName}" 必须是布尔值，收到: ${typeof value}`);
  }
  return value;
}

/**
 * 验证数组参数
 */
export function validateArray<T>(
  value: unknown,
  paramName: string,
  itemValidator?: (item: unknown) => T
): T[] {
  if (value === undefined || value === null) {
    throw new Error(`参数 "${paramName}" 是必需的`);
  }
  if (!Array.isArray(value)) {
    throw new Error(`参数 "${paramName}" 必须是数组，收到: ${typeof value}`);
  }
  if (itemValidator) {
    return value.map(itemValidator);
  }
  return value as T[];
}

/**
 * 验证对象参数
 */
export function validateObject<T extends Record<string, unknown>>(
  value: unknown,
  paramName: string
): T {
  if (value === undefined || value === null) {
    throw new Error(`参数 "${paramName}" 是必需的`);
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`参数 "${paramName}" 必须是对象，收到: ${Array.isArray(value) ? "array" : typeof value}`);
  }
  return value as T;
}
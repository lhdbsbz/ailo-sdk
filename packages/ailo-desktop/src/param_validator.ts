/**
 * 参数验证工具
 * 用于验证工具参数的类型和必需性，替代大量的 `as` 类型断言
 */

import { BodyError } from "@greatlhd/ailo-body";

/**
 * 参数问题用协议里的 INVALID_PARAMS，而不是笼统的 ACTION_FAILED：
 * 大脑据此知道该改参数重试，而不是换一条路。
 */
function invalidParams(message: string): BodyError {
  return new BodyError(message, "INVALID_PARAMS");
}

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
    throw invalidParams("参数不能为空");
  }
  if (typeof args !== "object") {
    throw invalidParams(`参数必须是对象，收到: ${typeof args}`);
  }

  const result: Record<string, unknown> = {};
  const inputArgs = args as Record<string, unknown>;

  for (const [key, spec] of Object.entries(schema)) {
    const value = inputArgs[key];

    // 处理必需参数
    if (spec.required && (value === undefined || value === null)) {
      throw invalidParams(`参数 "${key}" 是必需的`);
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
      throw invalidParams(
        `参数 "${key}" 类型错误: 期望 ${spec.type}, 收到 ${actualType}`
      );
    }

    // 数值范围验证
    if (spec.type === "number" && typeof value === "number") {
      if (spec.min !== undefined && value < spec.min) {
        throw invalidParams(`参数 "${key}" 必须 >= ${spec.min}, 收到 ${value}`);
      }
      if (spec.max !== undefined && value > spec.max) {
        throw invalidParams(`参数 "${key}" 必须 <= ${spec.max}, 收到 ${value}`);
      }
    }

    // 自定义验证
    if (spec.validate && !spec.validate(value)) {
      throw invalidParams(`参数 "${key}" 验证失败`);
    }

    result[key] = value;
  }

  return result as T;
}

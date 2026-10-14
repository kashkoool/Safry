import { BadRequestException } from "@nestjs/common";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import type { Response } from "express";

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 200;
export const MAX_PAGE_OFFSET = 100000;

/** Query parameters shared by every list endpoint: `?limit=` (1..200, default 100) and `?cursor=`. */
export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  /** Legacy offset paging, bounded; prefer `cursor`, which stays O(page) at any depth. Ignored when `cursor` is set. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_PAGE_OFFSET)
  offset?: number;
}

interface Cursor {
  t: string;
  id: string;
}

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ t: row.createdAt.toISOString(), id: row.id } satisfies Cursor)).toString("base64url");
}

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function decodeCursor(raw: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    // Strict ISO form as encodeCursor writes it, and a sane range: a parseable but absurd year (+275760-09-13) reaches
    // PostgreSQL as an out-of-range timestamp and answered 500.
    if (typeof parsed.t !== "string" || !CURSOR_TIME.test(parsed.t)) throw new Error();
    const createdAt = new Date(parsed.t);
    const year = createdAt.getUTCFullYear();
    if (typeof parsed.id !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.id) || Number.isNaN(createdAt.getTime()) || year < 2000 || year > 2100) throw new Error();
    return { createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException("cursor is invalid");
  }
}

/**
 * Keyset page over (createdAt DESC, id DESC): stable under inserts and O(page) at any depth, unlike
 * OFFSET. `where` is merged with AND so the caller's tenant/scope filter is never replaced.
 */
export function keysetPage<W extends object>(query: PageQueryDto, where: W): {
  where: W | { AND: [W, object] };
  orderBy: [{ createdAt: "desc" }, { id: "desc" }];
  take: number;
  skip?: number;
} {
  const limit = query.limit ?? DEFAULT_PAGE_SIZE;
  const base = {
    orderBy: [{ createdAt: "desc" }, { id: "desc" }] as [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1
  };
  if (!query.cursor) return { where, ...base, ...(query.offset ? { skip: query.offset } : {}) };
  const { createdAt, id } = decodeCursor(query.cursor);
  return { where: { AND: [where, { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] }] }, ...base };
}

/**
 * Trims the look-ahead row and exposes paging through response headers, so the JSON body stays the
 * plain array existing clients already read: `X-Next-Cursor` is present only when more rows exist.
 */
export function finishPage<T extends { createdAt: Date; id: string }>(rows: T[], query: PageQueryDto, response: Response): T[] {
  const limit = query.limit ?? DEFAULT_PAGE_SIZE;
  response.setHeader("Access-Control-Expose-Headers", "X-Next-Cursor");
  if (rows.length <= limit) return rows;
  const page = rows.slice(0, limit);
  response.setHeader("X-Next-Cursor", encodeCursor(page[limit - 1]!));
  return page;
}

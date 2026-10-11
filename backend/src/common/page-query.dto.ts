import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

/** Default and maximum page size of list endpoints; cursor pagination replaces this later. */
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 200;
export const MAX_PAGE_OFFSET = 100000;

export class PageQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: MAX_PAGE_OFFSET, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_PAGE_OFFSET)
  offset?: number;
}

export const page = ({ limit, offset }: PageQueryDto): { take: number; skip: number } => ({
  take: limit ?? DEFAULT_PAGE_SIZE,
  skip: offset ?? 0
});

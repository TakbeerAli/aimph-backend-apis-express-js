import { z } from 'zod';

export interface PageParams {
  page: number;
  limit: number;
  sort: string;
}

export interface PageResult<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

/** Zod schema for `?page=&limit=&sort=` where sort is `field` or `-field` from an allow-list. */
export function pageQuery(sortFields: readonly string[], defaultSort: string) {
  return z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    sort: z
      .string()
      .refine((value) => sortFields.includes(value.replace(/^-/, '')), {
        message: `Sort by one of: ${sortFields.join(', ')}`,
      })
      .default(defaultSort),
  });
}

/** `-name` → `{ name: -1, _id: -1 }`. `_id` keeps the order stable between pages. */
export function toMongoSort(sort: string): Record<string, 1 | -1> {
  const dir = sort.startsWith('-') ? -1 : 1;
  return { [sort.replace(/^-/, '')]: dir, _id: dir };
}

export const skipFor = ({ page, limit }: PageParams): number => (page - 1) * limit;

export function pageResult<T>(
  items: T[],
  total: number,
  { page, limit }: PageParams,
): PageResult<T> {
  return { items, page, limit, total };
}

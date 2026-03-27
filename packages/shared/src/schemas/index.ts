import { z } from 'zod';
import { statusMap } from '../constants';

export const AccountSchemas = {
  list: z.object({
    limit: z.number().min(1).max(1000).nullish(),
    cursor: z.string().nullish(),
  }),
  add: z.object({
    id: z.string().min(1).max(32),
    token: z.string().min(1),
    name: z.string().min(1),
    status: z.number().default(statusMap.ENABLE),
  }),
  edit: z.object({
    id: z.string(),
    data: z.object({
      token: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      status: z.number().optional(),
    }),
  }),
};

export const FeedSchemas = {
  list: z.object({
    limit: z.number().min(1).max(1000).nullish(),
    cursor: z.string().nullish(),
  }),
  add: z.object({
    id: z.string(),
    mpName: z.string(),
    mpCover: z.string(),
    mpIntro: z.string(),
    syncTime: z
      .number()
      .optional()
      .default(Math.floor(Date.now() / 1e3)),
    updateTime: z.number(),
    status: z.number().default(statusMap.ENABLE),
  }),
  edit: z.object({
    id: z.string(),
    data: z.object({
      mpName: z.string().optional(),
      mpCover: z.string().optional(),
      mpIntro: z.string().optional(),
      syncTime: z.number().optional(),
      updateTime: z.number().optional(),
      status: z.number().optional(),
    }),
  }),
  updateOrder: z.array(
    z.object({
      id: z.string(),
      order: z.number(),
    }),
  ),
};

export const ArticleSchemas = {
  list: z.object({
    limit: z.number().min(1).max(1000).nullish(),
    cursor: z.string().nullish(),
    mpId: z.string().nullish(),
    search: z.string().nullish(),
  }),
  add: z.object({
    id: z.string(),
    mpId: z.string(),
    title: z.string(),
    picUrl: z.string().optional().default(''),
    publishTime: z.number(),
  }),
};

export const PlatformSchemas = {
  getMpArticles: z.object({
    mpId: z.string(),
  }),
  getMpInfo: z.object({
    wxsLink: z
      .string()
      .refine((v) => v.startsWith('https://mp.weixin.qq.com/s/')),
  }),
  getLoginResult: z.object({
    id: z.string(),
  }),
};

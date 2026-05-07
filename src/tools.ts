import { z } from "zod";
import type {
  ConsolidatedWorklog,
  TempoCreateWorklogInput,
  TempoReadWorklogsInput,
  ToolResultPayload
} from "./types.js";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");
const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Time must be HH:MM");

export const tempoCreateWorklogSchema = z.object({
  issueKey: z.string().min(1),
  timeSpentHours: z.number().positive(),
  date: dateSchema,
  description: z.string().optional(),
  startTime: timeSchema.optional(),
  workAttributes: z
    .array(
      z.object({
        key: z.string().min(1),
        value: z.string().min(1)
      })
    )
    .optional()
});

export const tempoReadWorklogsSchema = z
  .object({
    startDate: dateSchema,
    endDate: dateSchema
  })
  .refine((value) => new Date(value.endDate).getTime() >= new Date(value.startDate).getTime(), {
    message: "endDate must be greater than or equal to startDate"
  });

export function parseTempoCreateWorklog(args: unknown): TempoCreateWorklogInput {
  return tempoCreateWorklogSchema.parse(args);
}

export function parseTempoReadWorklogs(args: unknown): TempoReadWorklogsInput {
  return tempoReadWorklogsSchema.parse(args);
}

// --- Tempo Push schemas ---

export const previewTempoPushSchema = z
  .object({
    date: z
      .string()
      .regex(/^(\d{4}-\d{2}-\d{2}|today)$/, "date must be YYYY-MM-DD or 'today'")
      .optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional()
  })
  .superRefine((value, ctx) => {
    const hasDate = value.date !== undefined;
    const hasRange = value.from !== undefined || value.to !== undefined;

    if (!hasDate && !hasRange) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either 'date' or both 'from' and 'to' are required"
      });
      return;
    }

    if (hasDate && hasRange) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Cannot specify both 'date' and 'from'/'to' range"
      });
      return;
    }

    if (hasRange) {
      if (!value.from || !value.to) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Both 'from' and 'to' are required when using a date range"
        });
        return;
      }

      if (new Date(value.to).getTime() < new Date(value.from).getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "'to' must be greater than or equal to 'from'"
        });
      }
    }
  });

const consolidatedWorklogSchema = z.object({
  issueKey: z.string().min(1),
  branch: z.string().min(1),
  folder: z.string().min(1).optional(),
  date: dateSchema,
  startTime: z.string().regex(/^\d{2}:\d{2}$/, "Expected HH:MM format"),
  durationHours: z.number().positive(),
  sessionIds: z.array(z.string().min(1)).min(1),
  windowCount: z.number().int().positive(),
  description: z.string().min(1)
});

export const pushTempoWorklogsSchema = z.object({
  worklogs: z.array(consolidatedWorklogSchema).min(1)
});

export type PreviewTempoPushInput = z.infer<typeof previewTempoPushSchema>;

export type PushTempoWorklogsInput = {
  worklogs: ConsolidatedWorklog[];
};

export function parsePreviewTempoPush(args: unknown): PreviewTempoPushInput {
  return previewTempoPushSchema.parse(args);
}

export function parsePushTempoWorklogs(args: unknown): PushTempoWorklogsInput {
  return pushTempoWorklogsSchema.parse(args);
}

export function buildToolResponse(payload: ToolResultPayload) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload
  };
}

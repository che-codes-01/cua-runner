// ─── Autonomous Task Agent (run_task) ─────────────────────────────────────────
//
// Finding 2 – Add high-level `run_task` action that drives the full
// screenshot → LLM-reason → act → screenshot loop autonomously.
//
// Uses Anthropic's computer-use beta (claude-3-5-sonnet-20241022 by default).
// The model decides which CUA actions to take; we relay them through the
// runner's existing executor, so every low-level action still goes through
// the daemon and gets traced.
//
import Anthropic       from '@anthropic-ai/sdk';
import { executeCuaAction } from './cua';
import { log }         from './logger';
import { config }      from './config';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RunTaskOptions {
  maxSteps?:    number;   // default: config.agentMaxSteps
  model?:       string;   // default: config.agentModel
  systemPrompt?: string;
}

export interface RunTaskResult {
  type:             'task_result';
  result:           string;
  steps:            number;
  success:          boolean;
  finalScreenshot?: string;  // base64 PNG of the last screenshot taken
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Choose the correct beta + tool type for a given model name. */
function computerUseMeta(model: string): { beta: string; toolType: string } {
  // claude-3-5-* family uses the 2024 beta
  if (/3[-.]?5/.test(model) || /3-haiku/.test(model)) {
    return { beta: 'computer-use-2024-10-22', toolType: 'computer_20241022' };
  }
  // claude-3-7-*, claude-opus-4-*, claude-sonnet-4-*, etc. use the 2025 beta
  return { beta: 'computer-use-2025-01-05', toolType: 'computer_20250124' };
}

/**
 * Map Anthropic's computer-use tool input format to our CuaAction format.
 * Anthropic uses { action: "left_click", coordinate: [x,y] }
 * We use          { type:   "left_click", coordinate: [x,y] }
 * Also remaps scroll field names.
 */
function mapAnthropicToRunner(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };

  // action → type
  if ('action' in out && !('type' in out)) {
    out.type = out.action;
    delete out.action;
  }

  // Anthropic scroll: { direction, amount } → our { scroll_direction, scroll_amount }
  if (out.type === 'scroll') {
    if ('direction' in out && !('scroll_direction' in out)) {
      out.scroll_direction = out.direction;
      delete out.direction;
    }
    if ('amount' in out && !('scroll_amount' in out)) {
      out.scroll_amount = out.amount;
      delete out.amount;
    }
  }

  return out;
}

// ── Agent loop ─────────────────────────────────────────────────────────────────

export async function runTask(
  task: string,
  sessionId: string,
  options: RunTaskOptions = {},
): Promise<RunTaskResult> {
  const apiKey = config.anthropicApiKey;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it to packages/runner/.env to use run_task.',
    );
  }

  const model    = options.model    ?? config.agentModel;
  const maxSteps = options.maxSteps ?? config.agentMaxSteps;
  const { beta, toolType } = computerUseMeta(model);

  log.info(`[agent] task="${task.slice(0, 80)}"  model=${model}  maxSteps=${maxSteps}`);

  const client = new Anthropic({ apiKey });

  // ── Take initial screenshot ────────────────────────────────────────────────
  const initShot = await executeCuaAction({ type: 'screenshot' }, sessionId) as {
    type: 'image'; data: string;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: options.systemPrompt
            ? `${options.systemPrompt}\n\nTask: ${task}`
            : `You are controlling a real computer. Complete this task:\n\n${task}\n\n` +
              `When you are done, write a short summary of what you accomplished.`,
        },
        {
          type:   'image',
          source: { type: 'base64', media_type: 'image/png', data: initShot.data },
        },
      ],
    },
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = [
    {
      type:              toolType,
      name:              'computer',
      display_width_px:  1280,
      display_height_px: 800,
    },
  ];

  let finalScreenshot: string | undefined = initShot.data;
  let stepCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    stepCount = step + 1;
    log.info(`[agent] Step ${stepCount}/${maxSteps}`);

    // ── Call LLM ─────────────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let response: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response = await (client.beta.messages as any).create({
        model,
        max_tokens: 4096,
        tools,
        messages,
        betas: [beta],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[agent] LLM call failed at step ${stepCount}: ${msg}`);
    }

    // Add assistant turn to history
    messages.push({ role: 'assistant', content: response.content });

    // ── Done? ─────────────────────────────────────────────────────────────────
    if (response.stop_reason === 'end_turn') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const textBlock = (response.content as any[]).find((b: any) => b.type === 'text');
      const result    = textBlock?.text ?? 'Task completed.';
      log.info(`[agent] Done in ${stepCount} steps: ${result.slice(0, 120)}`);
      return { type: 'task_result', result, steps: stepCount, success: true, finalScreenshot };
    }

    // ── Execute tool calls ────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolResults: any[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const block of response.content as any[]) {
      if (block.type !== 'tool_use') continue;

      const rawInput    = block.input as Record<string, unknown>;
      const actionInput = mapAnthropicToRunner(rawInput);

      log.info(`[agent]   → ${actionInput.type} ${JSON.stringify(actionInput).slice(0, 100)}`);

      try {
        const actionResult = await executeCuaAction(
          actionInput as Parameters<typeof executeCuaAction>[0],
          sessionId,
        ) as { type: string; data?: string; text?: string };

        if (actionResult.type === 'image' && actionResult.data) {
          finalScreenshot = actionResult.data;
          toolResults.push({
            type:        'tool_result',
            tool_use_id: block.id,
            content: [
              {
                type:   'image',
                source: { type: 'base64', media_type: 'image/png', data: actionResult.data },
              },
            ],
          });
        } else {
          toolResults.push({
            type:        'tool_result',
            tool_use_id: block.id,
            content:     actionResult.text ?? JSON.stringify(actionResult),
          });
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(`[agent]   ✗ ${actionInput.type} failed: ${errMsg}`);
        toolResults.push({
          type:        'tool_result',
          tool_use_id: block.id,
          content:     `Error: ${errMsg}`,
          is_error:    true,
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  log.warn(`[agent] Reached max steps (${maxSteps}) without end_turn`);
  return {
    type:            'task_result',
    result:          `Task did not complete within ${maxSteps} steps.`,
    steps:           maxSteps,
    success:         false,
    finalScreenshot,
  };
}

'use client';

import { useState } from 'react';

import { NativeSelect } from '~/components/ui/native-select';
import supportedModels, {
  MODEL_DESCRIPTIONS,
  type BexModelTag,
  type SupportedModel,
} from '~/lib/constants/models';

/**
 * B0-601 — model selector + validator toggle for the "Run dataset" form.
 *
 * A client component purely so the description under the dropdown can react to the selection; the
 * inputs are plain named form fields, so the enclosing server-action form (`runTestAction`) submits
 * them exactly as it did when this was inline markup.
 *
 * The `custom` tag is deliberately not offered: `resolveResponsesModel` throws on it unless
 * `BEX_RESPONSES_MODEL` is set, so it can only ever produce a failed run.
 */
export function TestRunModelControls() {
  const [modelTag, setModelTag] = useState<BexModelTag>('preview');

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <NativeSelect
          aria-label="Chat model for this run"
          className="h-9 w-44"
          name="modelTag"
          onChange={(event) => setModelTag(event.target.value as BexModelTag)}
          value={modelTag}
        >
          <option value="preview">Model: preview</option>
          {supportedModels.map((m: SupportedModel) => (
            <option key={m.name} value={m.name}>
              {m.label}
            </option>
          ))}
        </NativeSelect>

        <label
          className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
          htmlFor="run-use-validator"
        >
          <input
            className="size-3.5 cursor-pointer accent-primary"
            id="run-use-validator"
            name="useValidator"
            type="checkbox"
          />
          Validator pass
        </label>
      </div>

      <p className="max-w-md text-xs leading-snug text-muted-foreground">
        {MODEL_DESCRIPTIONS[modelTag]}
      </p>
    </div>
  );
}

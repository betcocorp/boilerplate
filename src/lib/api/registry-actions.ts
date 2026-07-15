'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { API_ENVIRONMENTS } from '~/lib/api/api-tokens';
import { createApp, createProject, mintToken } from '~/lib/api/registry-repository';

/**
 * B0-116 — server action for the new-project wizard: create project → first app → first token in
 * one flow. The full token is returned in the action result exactly once (shown in the modal) and
 * is never persisted or re-retrievable.
 */

const PROJECTS_PATH = '/admin/projects';

const wizardSchema = z.object({
  projectName: z.string().trim().min(1, 'Project name is required.').max(200),
  description: z.string().trim().max(2000).optional(),
  contactEmail: z.union([z.string().trim().email('Enter a valid email.'), z.literal('')]).optional(),
  appName: z.string().trim().min(1, 'App name is required.').max(200),
  environment: z.enum(API_ENVIRONMENTS),
  tokenLabel: z.string().trim().max(200).optional(),
});

export type CreateProjectWizardState =
  | {
      ok: true;
      token: string;
      prefix: string;
      projectId: string;
      appId: string;
      projectName: string;
      appName: string;
      environment: string;
    }
  | { ok: false; error: string }
  | null;

export async function createProjectWizardAction(
  _prev: CreateProjectWizardState,
  formData: FormData,
): Promise<CreateProjectWizardState> {
  const parsed = wizardSchema.safeParse({
    projectName: formData.get('projectName') ?? '',
    description: (formData.get('description') as string | null) ?? undefined,
    contactEmail: (formData.get('contactEmail') as string | null) ?? undefined,
    appName: formData.get('appName') ?? '',
    environment: formData.get('environment') ?? '',
    tokenLabel: (formData.get('tokenLabel') as string | null) ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid form data.' };
  }

  const { projectName, description, contactEmail, appName, environment, tokenLabel } = parsed.data;
  try {
    const project = await createProject({
      name: projectName,
      description: description || null,
      contactEmail: contactEmail || null,
    });
    const app = await createApp({ projectId: project.id, name: appName, environment });
    const minted = await mintToken({
      appId: app.id,
      environment,
      label: tokenLabel || 'Initial token',
    });

    revalidatePath(PROJECTS_PATH);
    return {
      ok: true,
      token: minted.token,
      prefix: minted.key.prefix,
      projectId: project.id,
      appId: app.id,
      projectName: project.name,
      appName: app.name,
      environment,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to create project.' };
  }
}

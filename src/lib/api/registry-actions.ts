'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { API_ENVIRONMENTS } from '~/lib/api/api-tokens';
import {
  createApp,
  createProject,
  mintToken,
  setProjectActive,
  updateProject,
} from '~/lib/api/registry-repository';

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

// --- B0-130: project detail actions -------------------------------------------------------------

export type SimpleActionState = { ok: boolean; error: string | null } | null;

const projectFieldsSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1, 'Project name is required.').max(200),
  description: z.string().trim().max(2000).optional(),
  contactEmail: z.union([z.string().trim().email('Enter a valid email.'), z.literal('')]).optional(),
});

export async function updateProjectAction(
  _prev: SimpleActionState,
  formData: FormData,
): Promise<SimpleActionState> {
  const parsed = projectFieldsSchema.safeParse({
    projectId: formData.get('projectId') ?? '',
    name: formData.get('name') ?? '',
    description: (formData.get('description') as string | null) ?? undefined,
    contactEmail: (formData.get('contactEmail') as string | null) ?? undefined,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid form data.' };
  try {
    await updateProject(parsed.data.projectId, {
      name: parsed.data.name,
      description: parsed.data.description || null,
      contactEmail: parsed.data.contactEmail || null,
    });
    revalidatePath(`${PROJECTS_PATH}/${parsed.data.projectId}`);
    revalidatePath(PROJECTS_PATH);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to update project.' };
  }
}

export async function setProjectActiveAction(
  _prev: SimpleActionState,
  formData: FormData,
): Promise<SimpleActionState> {
  const projectId = String(formData.get('projectId') ?? '');
  const isActive = String(formData.get('isActive') ?? '') === 'true';
  if (!projectId) return { ok: false, error: 'Missing project id.' };
  try {
    await setProjectActive(projectId, isActive);
    revalidatePath(`${PROJECTS_PATH}/${projectId}`);
    revalidatePath(PROJECTS_PATH);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to toggle project.' };
  }
}

const addAppSchema = z.object({
  projectId: z.string().uuid(),
  appName: z.string().trim().min(1, 'App name is required.').max(200),
  environment: z.enum(API_ENVIRONMENTS),
  issueToken: z.boolean(),
  tokenLabel: z.string().trim().max(200).optional(),
});

export type AddAppState =
  | { ok: true; appId: string; appName: string; environment: string; token: string | null; prefix: string | null }
  | { ok: false; error: string }
  | null;

export async function addAppAction(_prev: AddAppState, formData: FormData): Promise<AddAppState> {
  const parsed = addAppSchema.safeParse({
    projectId: formData.get('projectId') ?? '',
    appName: formData.get('appName') ?? '',
    environment: formData.get('environment') ?? '',
    issueToken: formData.get('issueToken') === 'on' || formData.get('issueToken') === 'true',
    tokenLabel: (formData.get('tokenLabel') as string | null) ?? undefined,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid form data.' };

  try {
    const app = await createApp({
      projectId: parsed.data.projectId,
      name: parsed.data.appName,
      environment: parsed.data.environment,
    });
    let token: string | null = null;
    let prefix: string | null = null;
    if (parsed.data.issueToken) {
      const minted = await mintToken({
        appId: app.id,
        environment: parsed.data.environment,
        label: parsed.data.tokenLabel || 'Initial token',
      });
      token = minted.token;
      prefix = minted.key.prefix;
    }
    revalidatePath(`${PROJECTS_PATH}/${parsed.data.projectId}`);
    revalidatePath(PROJECTS_PATH);
    return { ok: true, appId: app.id, appName: app.name, environment: parsed.data.environment, token, prefix };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to add app.' };
  }
}

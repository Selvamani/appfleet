import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type FormEvent, type TextareaHTMLAttributes } from 'react';
import { useNavigate } from 'react-router';
import { createApplication } from '../../api/control';
import { isApiError } from '../../api/http';
import { listTeams } from '../../api/identity';
import { qk } from '../../api/keys';
import type { CreateApplicationRequest } from '../../api/types';
import { usePermissions } from '../../auth/usePermissions';
import {
  Button, ButtonLink, Card, Columns, ErrorNotice, Loading, Notice, PageHeader, Row, SelectField, TextField,
} from '../../components';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { cx } from '../../lib/cx';
import s from './applications.module.css';
import { ProblemNotice } from './notices';
import { fieldErrorsOf, isProblem, sentence, useFocusFirstInvalid } from './shared';

const FIELDS = ['name', 'description', 'ownerTeamId'];
const DESCRIPTION_MAX = 1000;

/** Multi-line text field with the same label, hint and error wiring as TextField. */
function TextAreaField({ label, hint, error, id, ...rest }: {
  label: string; hint?: string; error?: string;
} & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errId = error ? `${fieldId}-err` : undefined;
  return (
    <div className={s.field}>
      <label className={s.fieldLabel} htmlFor={fieldId}>{label}</label>
      <textarea
        id={fieldId}
        className={cx(s.textarea, error && s.textareaInvalid)}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errId].filter(Boolean).join(' ') || undefined}
        {...rest}
      />
      {hint && <p id={hintId} className={s.hint}>{hint}</p>}
      {error && <p id={errId} className={s.error}>{error}</p>}
    </div>
  );
}

export function NewApplicationPage() {
  useDocumentTitle('Register application');
  const { me, isLoading: permsLoading, can } = usePermissions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const teams = useQuery({ queryKey: qk.teams(), queryFn: listTeams, staleTime: 10 * 60_000 });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [teamChoice, setTeamChoice] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  const create = useMutation({
    mutationFn: (body: CreateApplicationRequest) => createApplication(body),
    onSuccess: app => {
      queryClient.setQueryData(qk.application(app.id), app);
      void queryClient.invalidateQueries({ queryKey: qk.applications() });
      navigate(`/applications/${app.id}`);
    },
  });
  useFocusFirstInvalid(formRef, create.error);

  const creatable = (teams.data ?? []).filter(t => can('application:create', t.id));
  const ownerTeamId = teamChoice || creatable[0]?.id || '';

  const fieldErrors = fieldErrorsOf(create.error);
  if (isProblem(create.error, 'conflict') && isApiError(create.error)) fieldErrors.name = sentence(create.error.detail);
  const unmapped = isProblem(create.error, 'validation-failed') && isApiError(create.error)
    ? create.error.errors.filter(e => !FIELDS.includes(e.field))
    : [];

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const body: CreateApplicationRequest = { name: name.trim(), ownerTeamId };
    if (description.trim()) body.description = description.trim();
    create.mutate(body);
  };

  const header = (
    <PageHeader
      crumbs={[{ label: 'Applications', to: '/applications' }, { label: 'Register application' }]}
      title="Register application"
      subtitle="An application is what you release and deploy. Its owner team decides who may deploy it."
    />
  );

  if ((permsLoading && !me) || teams.isPending) {
    return <>{header}<Loading label="Loading your teams" /></>;
  }
  if (teams.isError) {
    return <>{header}<ErrorNotice error={teams.error} context="Could not load teams." onRetry={() => void teams.refetch()} /></>;
  }
  if (creatable.length === 0) {
    return (
      <>
        {header}
        <Notice
          tone="info"
          title="You cannot register applications"
          actions={<ButtonLink to="/applications" size="sm">Back to applications</ButtonLink>}
        >
          <p>Registering an application needs DEPLOYER on the team that will own it. You have that role on no team.</p>
        </Notice>
      </>
    );
  }

  return (
    <>
      {header}
      <Columns layout="two" className={s.limitNarrow}>
        <Card>
          <form ref={formRef} className={cx(s.form, s.formNarrow)} onSubmit={onSubmit} noValidate aria-label="Register application">
            <TextField
              label="Name"
              name="name"
              value={name}
              onChange={e => setName(e.target.value)}
              hint="Lowercase letters, digits and hyphens, starting with a letter or digit. Up to 63 characters, for example billing-api."
              error={fieldErrors.name}
              required
              autoComplete="off"
              spellCheck={false}
              maxLength={63}
            />
            <TextAreaField
              label="Description (optional)"
              name="description"
              value={description}
              onChange={e => setDescription(e.target.value)}
              hint={`One or two sentences on what it does. Up to ${DESCRIPTION_MAX} characters.`}
              error={fieldErrors.description}
              maxLength={DESCRIPTION_MAX}
              rows={3}
            />
            <SelectField
              label="Owner team"
              name="ownerTeamId"
              value={ownerTeamId}
              onChange={e => setTeamChoice(e.target.value)}
              hint="Listed: the teams where you may register applications. People with DEPLOYER on the owner team can release and deploy it."
              error={fieldErrors.ownerTeamId}
              required
            >
              {creatable.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </SelectField>

            {isProblem(create.error, 'forbidden') && (
              <ProblemNotice error={create.error} title="Not allowed" />
            )}
            {isProblem(create.error, 'unprocessable') && (
              <ProblemNotice error={create.error} title="The request was refused" />
            )}
            {unmapped.length > 0 && <ErrorNotice error={create.error} />}
            {create.isError && !isProblem(create.error, 'validation-failed', 'conflict', 'forbidden', 'unprocessable') && (
              <ErrorNotice error={create.error} context="The application was not registered." onRetry={() => formRef.current?.requestSubmit()} />
            )}

            <Row>
              <Button type="submit" variant="primary" busy={create.isPending} disabled={create.isPending}>
                Register application
              </Button>
              <ButtonLink to="/applications">Cancel</ButtonLink>
            </Row>
          </form>
        </Card>
        <Card as="aside" title="After you register" titleId="after-register-title">
          <ol className={s.steps}>
            <li><b>Register a release.</b> A release is one version with its artifact and sha256 checksum. It cannot be changed afterwards.</li>
            <li><b>Deploy it.</b> Choose a release and an environment; the deployment is accepted at once and runs in the background.</li>
            <li><b>Watch what runs where.</b> The application page shows the current release and state in every environment.</li>
          </ol>
        </Card>
      </Columns>
    </>
  );
}

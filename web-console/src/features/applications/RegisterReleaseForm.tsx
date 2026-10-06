import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRelease } from '../../api/control';
import { isApiError } from '../../api/http';
import { qk } from '../../api/keys';
import type { CreateReleaseRequest, ReleaseResponse } from '../../api/types';
import { Button, Card, Columns, ErrorNotice, Row, TextField } from '../../components';
import s from './applications.module.css';
import { ProblemNotice } from './notices';
import { fieldErrorsOf, isProblem, sentence, useFocusFirstInvalid } from './shared';

const FIELDS = ['version', 'artifactRef', 'checksum'];

/** Registers one release of an application. Releases are immutable once registered. */
export function RegisterReleaseForm({ applicationId, artifactHint, onRegistered, onCancel }: {
  applicationId: string;
  /** For the placeholder, for example "registry.internal/payments/billing-api". */
  artifactHint: string;
  onRegistered: (release: ReleaseResponse) => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const [version, setVersion] = useState('');
  const [artifactRef, setArtifactRef] = useState('');
  const [checksum, setChecksum] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  const create = useMutation({
    mutationFn: (body: CreateReleaseRequest) => createRelease(applicationId, body),
    onSuccess: release => {
      void queryClient.invalidateQueries({ queryKey: qk.releases(applicationId) });
      onRegistered(release);
    },
  });
  useFocusFirstInvalid(formRef, create.error);

  // Opening the form moves focus into it.
  useEffect(() => {
    formRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, []);

  const fieldErrors = fieldErrorsOf(create.error);
  if (isProblem(create.error, 'conflict') && isApiError(create.error)) fieldErrors.version = sentence(create.error.detail);
  const unmapped = isProblem(create.error, 'validation-failed') && isApiError(create.error)
    ? create.error.errors.filter(e => !FIELDS.includes(e.field))
    : [];

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ version: version.trim(), artifactRef: artifactRef.trim(), checksum: checksum.trim() });
  };

  return (
    <Card title="Register a release" titleId="register-release-title">
      <form
        ref={formRef}
        id="register-release"
        className={s.form}
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="register-release-title"
      >
        <Columns layout="three">
          <TextField
            label="Version"
            className={s.mono}
            value={version}
            onChange={e => setVersion(e.target.value)}
            placeholder="2.5.0"
            hint="Letters, digits and . _ + -, starting with a letter or digit. Up to 64 characters."
            error={fieldErrors.version}
            required
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
          />
          <TextField
            label="Artifact reference"
            className={s.mono}
            value={artifactRef}
            onChange={e => setArtifactRef(e.target.value)}
            placeholder={`${artifactHint}:2.5.0`}
            hint="Where the deployable image lives."
            error={fieldErrors.artifactRef}
            required
            maxLength={512}
            autoComplete="off"
            spellCheck={false}
          />
          <TextField
            label="Checksum"
            className={s.mono}
            value={checksum}
            onChange={e => setChecksum(e.target.value)}
            placeholder="sha256:…"
            hint="sha256: followed by 64 lowercase hex characters."
            error={fieldErrors.checksum}
            required
            autoComplete="off"
            spellCheck={false}
          />
        </Columns>
        <p className={s.small}>A release cannot be changed after it is registered. Check the values before you register it.</p>

        {isProblem(create.error, 'forbidden') && <ProblemNotice error={create.error} title="Not allowed" />}
        {unmapped.length > 0 && <ErrorNotice error={create.error} />}
        {create.isError && !isProblem(create.error, 'validation-failed', 'conflict', 'forbidden') && (
          <ErrorNotice error={create.error} context="The release was not registered." onRetry={() => formRef.current?.requestSubmit()} />
        )}

        <Row>
          <Button type="submit" variant="primary" busy={create.isPending} disabled={create.isPending}>Register release</Button>
          <Button onClick={onCancel}>Cancel</Button>
        </Row>
      </form>
    </Card>
  );
}

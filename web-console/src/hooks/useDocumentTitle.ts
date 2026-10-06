import { useEffect } from 'react';

/** Sets the browser tab title, so each screen is named for assistive technology and history. */
export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    if (title) document.title = `${title} - Appfleet`;
  }, [title]);
}

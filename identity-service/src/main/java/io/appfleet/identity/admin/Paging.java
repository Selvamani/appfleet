package io.appfleet.identity.admin;

import io.appfleet.identity.admin.AdminDTOs.PageOf;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;

import java.util.List;
import java.util.UUID;
import java.util.function.Function;

/** Keyset paging, shared by the lists: ask for one row more than the limit; if it comes, there is a next page. */
final class Paging {

    static final int DEFAULT_LIMIT = 50;
    static final int MAX_LIMIT = 200;

    private Paging() {}

    static int clamp(int limit) {
        return Math.max(1, Math.min(limit, MAX_LIMIT));
    }

    /** What to ask the repository for: the limit plus the one row that shows whether another page exists. */
    static Pageable request(int limit) {
        return PageRequest.of(0, clamp(limit) + 1);
    }

    static <E, T> PageOf<T> of(List<E> fetched, int limit, Function<E, UUID> id, Function<E, T> view) {
        int size = clamp(limit);
        boolean more = fetched.size() > size;
        List<E> page = more ? fetched.subList(0, size) : fetched;
        return new PageOf<>(page.stream().map(view).toList(), more ? id.apply(page.get(page.size() - 1)).toString() : null);
    }
}
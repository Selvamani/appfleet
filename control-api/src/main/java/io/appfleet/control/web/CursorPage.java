package io.appfleet.control.web;

import java.util.List;

public record CursorPage<T>(List<T> items, String nextCursor) {
}

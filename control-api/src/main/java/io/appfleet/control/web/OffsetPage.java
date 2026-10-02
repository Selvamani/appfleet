package io.appfleet.control.web;

import java.util.List;

public record OffsetPage<T>(List<T> items, int page, int size, boolean hasNext) {}
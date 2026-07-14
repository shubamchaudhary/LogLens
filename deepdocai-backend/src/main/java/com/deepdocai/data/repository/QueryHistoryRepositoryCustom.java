package com.deepdocai.data.repository;

import com.deepdocai.data.entity.QueryHistory;

import java.util.List;
import java.util.UUID;

public interface QueryHistoryRepositoryCustom {
    List<QueryHistory> findByChatIdExcludingEmbedding(UUID chatId, int limit);
}


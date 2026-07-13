export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  rag: {
    Tables: {
      document: {
        Row: {
          body_markdown: string | null
          body_text: string
          created_at: string
          document_key: string
          document_kind: string
          entity_id: string | null
          id: string
          language_code: string
          metadata: Json
          source_record_id: string
          summary: string | null
          title: string
          token_count: number | null
          updated_at: string
        }
        Insert: {
          body_markdown?: string | null
          body_text: string
          created_at?: string
          document_key: string
          document_kind: string
          entity_id?: string | null
          id?: string
          language_code?: string
          metadata?: Json
          source_record_id: string
          summary?: string | null
          title: string
          token_count?: number | null
          updated_at?: string
        }
        Update: {
          body_markdown?: string | null
          body_text?: string
          created_at?: string
          document_key?: string
          document_kind?: string
          entity_id?: string | null
          id?: string
          language_code?: string
          metadata?: Json
          source_record_id?: string
          summary?: string | null
          title?: string
          token_count?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "entity"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_source_record_id_fkey"
            columns: ["source_record_id"]
            isOneToOne: false
            referencedRelation: "source_record"
            referencedColumns: ["id"]
          },
        ]
      }
      document_chunk: {
        Row: {
          chunk_index: number
          chunk_key: string
          chunk_text: string
          created_at: string
          document_id: string
          embedding: string | null
          embedding_large: unknown
          embedding_model: string | null
          embedding_model_large: string | null
          heading: string | null
          id: string
          metadata: Json
          search_vector: unknown
          section_path: string[]
          section_type: string | null
          token_count: number | null
          updated_at: string
        }
        Insert: {
          chunk_index: number
          chunk_key: string
          chunk_text: string
          created_at?: string
          document_id: string
          embedding?: string | null
          embedding_large?: unknown
          embedding_model?: string | null
          embedding_model_large?: string | null
          heading?: string | null
          id?: string
          metadata?: Json
          search_vector?: unknown
          section_path?: string[]
          section_type?: string | null
          token_count?: number | null
          updated_at?: string
        }
        Update: {
          chunk_index?: number
          chunk_key?: string
          chunk_text?: string
          created_at?: string
          document_id?: string
          embedding?: string | null
          embedding_large?: unknown
          embedding_model?: string | null
          embedding_model_large?: string | null
          heading?: string | null
          id?: string
          metadata?: Json
          search_vector?: unknown
          section_path?: string[]
          section_type?: string | null
          token_count?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_chunk_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "document"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_chunk_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "suspect_sds_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      entity: {
        Row: {
          canonical_key: string
          created_at: string
          entity_type: string
          id: string
          metadata: Json
          product_key: string | null
          product_line_key: string | null
          sku: string | null
          title: string | null
          updated_at: string
        }
        Insert: {
          canonical_key: string
          created_at?: string
          entity_type: string
          id?: string
          metadata?: Json
          product_key?: string | null
          product_line_key?: string | null
          sku?: string | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          canonical_key?: string
          created_at?: string
          entity_type?: string
          id?: string
          metadata?: Json
          product_key?: string | null
          product_line_key?: string | null
          sku?: string | null
          title?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      entity_link: {
        Row: {
          created_at: string
          from_entity_id: string
          metadata: Json
          relation_type: string
          to_entity_id: string
        }
        Insert: {
          created_at?: string
          from_entity_id: string
          metadata?: Json
          relation_type: string
          to_entity_id: string
        }
        Update: {
          created_at?: string
          from_entity_id?: string
          metadata?: Json
          relation_type?: string
          to_entity_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "entity_link_from_entity_id_fkey"
            columns: ["from_entity_id"]
            isOneToOne: false
            referencedRelation: "entity"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entity_link_to_entity_id_fkey"
            columns: ["to_entity_id"]
            isOneToOne: false
            referencedRelation: "entity"
            referencedColumns: ["id"]
          },
        ]
      }
      search_embedding: {
        Row: {
          avg_cache_lookup_ms: number
          avg_cache_persist_ms: number
          avg_embedding_create_ms: number
          avg_query_embedding_ms: number
          avg_query_rewrite_ms: number
          avg_similarity_search_ms: number
          avg_total_search_ms: number
          created_at: string
          deleted_at: string | null
          embeddings: string | null
          embeddings_large: unknown
          id: number
          query_count: number
          query_rewritten: string | null
          query_string: string
          timing_sample_count: number
          updated_at: string | null
        }
        Insert: {
          avg_cache_lookup_ms?: number
          avg_cache_persist_ms?: number
          avg_embedding_create_ms?: number
          avg_query_embedding_ms?: number
          avg_query_rewrite_ms?: number
          avg_similarity_search_ms?: number
          avg_total_search_ms?: number
          created_at?: string
          deleted_at?: string | null
          embeddings?: string | null
          embeddings_large?: unknown
          id?: number
          query_count?: number
          query_rewritten?: string | null
          query_string: string
          timing_sample_count?: number
          updated_at?: string | null
        }
        Update: {
          avg_cache_lookup_ms?: number
          avg_cache_persist_ms?: number
          avg_embedding_create_ms?: number
          avg_query_embedding_ms?: number
          avg_query_rewrite_ms?: number
          avg_similarity_search_ms?: number
          avg_total_search_ms?: number
          created_at?: string
          deleted_at?: string | null
          embeddings?: string | null
          embeddings_large?: unknown
          id?: number
          query_count?: number
          query_rewritten?: string | null
          query_string?: string
          timing_sample_count?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      source_record: {
        Row: {
          checksum: string | null
          created_at: string
          id: string
          is_active: boolean
          last_seen_at: string
          metadata: Json
          source_locale: string
          source_pk: string
          source_schema: string
          source_table: string
          source_type: string
          source_uri: string | null
          updated_at: string
        }
        Insert: {
          checksum?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          last_seen_at?: string
          metadata?: Json
          source_locale?: string
          source_pk: string
          source_schema: string
          source_table: string
          source_type: string
          source_uri?: string | null
          updated_at?: string
        }
        Update: {
          checksum?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          last_seen_at?: string
          metadata?: Json
          source_locale?: string
          source_pk?: string
          source_schema?: string
          source_table?: string
          source_type?: string
          source_uri?: string | null
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      legacy_product_line_profile_source: {
        Row: {
          body_text: string | null
          document_key: string | null
          entity_key: string | null
          entity_type: string | null
          language_code: string | null
          metadata: Json | null
          product_key: string | null
          product_line_key: string | null
          sku: string | null
          source_pk: string | null
          source_schema: string | null
          source_table: string | null
          source_type: string | null
          title: string | null
        }
        Relationships: []
      }
      legacy_product_profile_source: {
        Row: {
          body_text: string | null
          document_key: string | null
          entity_key: string | null
          entity_type: string | null
          language_code: string | null
          metadata: Json | null
          product_line_key: string | null
          sku: string | null
          source_pk: string | null
          source_schema: string | null
          source_table: string | null
          source_type: string | null
          title: string | null
        }
        Relationships: []
      }
      suspect_sds_documents: {
        Row: {
          body_text_length: number | null
          body_text_preview: string | null
          document_key: string | null
          id: string | null
          language_code: string | null
          product_line_key: string | null
          source_pk: string | null
          title: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      backfill_token_counts_batch: {
        Args: { p_batch_size?: number }
        Returns: Json
      }
      chunk_document_text: {
        Args: {
          p_body_text: string
          p_max_chars?: number
          p_overlap_chars?: number
          p_title?: string
        }
        Returns: {
          chunk_index: number
          chunk_text: string
          heading: string
          section_path: string[]
          token_count: number
        }[]
      }
      chunk_sds_document_text:
        | {
            Args: {
              p_body_text: string
              p_max_chars?: number
              p_overlap_chars?: number
            }
            Returns: {
              chunk_index: number
              chunk_text: string
              heading: string
              section_path: string[]
              token_count: number
            }[]
          }
        | {
            Args: {
              p_body_text: string
              p_max_chars?: number
              p_overlap_chars?: number
              p_title?: string
            }
            Returns: {
              chunk_index: number
              chunk_text: string
              heading: string
              section_path: string[]
              token_count: number
            }[]
          }
      enrich_sds_section_headings_batch: {
        Args: { p_batch_size?: number }
        Returns: Json
      }
      find_similar_search_embedding: {
        Args: {
          p_query: string
          p_query_similarity_threshold?: number
          p_rewritten_similarity_threshold?: number
        }
        Returns: {
          avg_cache_lookup_ms: number
          avg_cache_persist_ms: number
          avg_embedding_create_ms: number
          avg_query_embedding_ms: number
          avg_query_rewrite_ms: number
          avg_similarity_search_ms: number
          avg_total_search_ms: number
          embeddings_large: unknown
          id: number
          match_source: string
          matched_similarity: number
          query_count: number
          query_rewritten: string
          query_string: string
          timing_sample_count: number
        }[]
      }
      match_corpus_chunks: {
        Args: {
          filter_product_line_key?: string
          filter_scope?: string
          filter_section_type?: string
          match_count?: number
          query_embedding: unknown
        }
        Returns: {
          chunk_id: string
          chunk_index: number
          chunk_key: string
          chunk_text: string
          document_id: string
          document_key: string
          document_kind: string
          document_title: string
          entity_id: string
          heading: string
          product_key: string
          product_line_key: string
          section_path: string[]
          section_type: string
          similarity: number
          sku: string
          source_pk: string
          token_count: number
        }[]
      }
      match_corpus_chunks_hybrid: {
        Args: {
          filter_product_line_key?: string
          filter_scope?: string
          filter_section_type?: string
          match_count?: number
          query_embedding: unknown
          query_text: string
        }
        Returns: {
          chunk_id: string
          chunk_index: number
          chunk_key: string
          chunk_text: string
          document_id: string
          document_key: string
          document_kind: string
          document_title: string
          entity_id: string
          heading: string
          product_key: string
          product_line_key: string
          section_path: string[]
          section_type: string
          similarity: number
          sku: string
          source_pk: string
          token_count: number
        }[]
      }
      match_product_chunks:
        | {
            Args: {
              filter_product_key?: string
              filter_product_line_key?: string
              match_count?: number
              query_embedding: unknown
            }
            Returns: {
              chunk_id: string
              chunk_index: number
              chunk_key: string
              chunk_text: string
              document_id: string
              document_key: string
              document_title: string
              entity_id: string
              heading: string
              product_key: string
              product_line_key: string
              section_path: string[]
              similarity: number
              sku: string
              source_pk: string
              token_count: number
            }[]
          }
        | {
            Args: {
              filter_product_key?: string
              filter_product_line_key?: string
              filter_section_type?: string
              match_count?: number
              query_embedding: unknown
            }
            Returns: {
              chunk_id: string
              chunk_index: number
              chunk_key: string
              chunk_text: string
              document_id: string
              document_key: string
              document_kind: string
              document_title: string
              entity_id: string
              heading: string
              product_key: string
              product_line_key: string
              section_path: string[]
              section_type: string
              similarity: number
              sku: string
              source_pk: string
              token_count: number
            }[]
          }
      match_product_chunks_hybrid:
        | {
            Args: {
              filter_product_key?: string
              filter_product_line_key?: string
              match_count?: number
              query_embedding: unknown
              query_text: string
            }
            Returns: {
              chunk_id: string
              chunk_index: number
              chunk_key: string
              chunk_text: string
              document_id: string
              document_key: string
              document_title: string
              entity_id: string
              heading: string
              product_key: string
              product_line_key: string
              section_path: string[]
              similarity: number
              sku: string
              source_pk: string
              token_count: number
            }[]
          }
        | {
            Args: {
              filter_product_key?: string
              filter_product_line_key?: string
              filter_section_type?: string
              match_count?: number
              query_embedding: unknown
              query_text: string
            }
            Returns: {
              chunk_id: string
              chunk_index: number
              chunk_key: string
              chunk_text: string
              document_id: string
              document_key: string
              document_kind: string
              document_title: string
              entity_id: string
              heading: string
              product_key: string
              product_line_key: string
              section_path: string[]
              section_type: string
              similarity: number
              sku: string
              source_pk: string
              token_count: number
            }[]
          }
      match_product_chunks_v2: {
        Args: {
          filter_product_key?: string
          filter_product_line_key?: string
          match_count?: number
          query_embedding: unknown
        }
        Returns: {
          chunk_id: string
          chunk_index: number
          chunk_key: string
          chunk_text: string
          document_id: string
          document_key: string
          document_title: string
          entity_id: string
          heading: string
          product_key: string
          product_line_key: string
          section_path: string[]
          similarity: number
          sku: string
          source_pk: string
          token_count: number
        }[]
      }
      run_bulk_sds_heading_backfill: { Args: never; Returns: Json }
      sync_legacy_product_profile_chunks: {
        Args: { p_language_code?: string }
        Returns: Json
      }
      sync_legacy_product_profiles: {
        Args: { p_language_code?: string }
        Returns: Json
      }
      sync_sds_chunks: {
        Args: {
          p_language_code?: string
          p_max_chars?: number
          p_overlap_chars?: number
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  rag: {
    Enums: {},
  },
} as const

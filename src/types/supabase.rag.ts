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
      cross_reference_recommendation_candidates: {
        Row: {
          betco_prod_id: string | null
          betco_product_key: string | null
          betco_title: string | null
          candidate_confidence: number | null
          created_at: string
          id: string
          rank: number | null
          rationale: string | null
          recommendation_id: string
          source: Json
        }
        Insert: {
          betco_prod_id?: string | null
          betco_product_key?: string | null
          betco_title?: string | null
          candidate_confidence?: number | null
          created_at?: string
          id?: string
          rank?: number | null
          rationale?: string | null
          recommendation_id: string
          source?: Json
        }
        Update: {
          betco_prod_id?: string | null
          betco_product_key?: string | null
          betco_title?: string | null
          candidate_confidence?: number | null
          created_at?: string
          id?: string
          rank?: number | null
          rationale?: string | null
          recommendation_id?: string
          source?: Json
        }
        Relationships: [
          {
            foreignKeyName: "cross_reference_recommendation_candidate_recommendation_id_fkey"
            columns: ["recommendation_id"]
            isOneToOne: false
            referencedRelation: "cross_reference_recommendations"
            referencedColumns: ["id"]
          },
        ]
      }
      cross_reference_recommendations: {
        Row: {
          answer_given: boolean
          competitor_brand: string | null
          competitor_product: string
          created_at: string
          created_by: string | null
          decline_reason: string | null
          evidence: Json
          id: string
          normalized_input: Json
          overall_confidence: number | null
          status: string
          threshold_used: number | null
          updated_at: string
        }
        Insert: {
          answer_given?: boolean
          competitor_brand?: string | null
          competitor_product: string
          created_at?: string
          created_by?: string | null
          decline_reason?: string | null
          evidence?: Json
          id?: string
          normalized_input?: Json
          overall_confidence?: number | null
          status?: string
          threshold_used?: number | null
          updated_at?: string
        }
        Update: {
          answer_given?: boolean
          competitor_brand?: string | null
          competitor_product?: string
          created_at?: string
          created_by?: string | null
          decline_reason?: string | null
          evidence?: Json
          id?: string
          normalized_input?: Json
          overall_confidence?: number | null
          status?: string
          threshold_used?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      document: {
        Row: {
          body_markdown: string | null
          body_text: string
          chemistry_class: string | null
          cites_data_from_document_id: string | null
          contact_time_seconds: number | null
          created_at: string
          dilution_oz_per_gal: number | null
          document_key: string
          document_kind: string
          entity_id: string | null
          epa_distributor_number: string | null
          epa_registrant: string | null
          epa_registrant_role: string | null
          epa_registration: string | null
          id: string
          ingested_by: string | null
          is_current: boolean
          language_code: string
          lifecycle_status: string
          metadata: Json
          product_application: string | null
          profile_summary: string | null
          project_number: string | null
          source_lab: string | null
          source_record_id: string
          summary: string | null
          superseded_by_document_id: string | null
          title: string
          token_count: number | null
          updated_at: string
        }
        Insert: {
          body_markdown?: string | null
          body_text: string
          chemistry_class?: string | null
          cites_data_from_document_id?: string | null
          contact_time_seconds?: number | null
          created_at?: string
          dilution_oz_per_gal?: number | null
          document_key: string
          document_kind: string
          entity_id?: string | null
          epa_distributor_number?: string | null
          epa_registrant?: string | null
          epa_registrant_role?: string | null
          epa_registration?: string | null
          id?: string
          ingested_by?: string | null
          is_current?: boolean
          language_code?: string
          lifecycle_status?: string
          metadata?: Json
          product_application?: string | null
          profile_summary?: string | null
          project_number?: string | null
          source_lab?: string | null
          source_record_id: string
          summary?: string | null
          superseded_by_document_id?: string | null
          title: string
          token_count?: number | null
          updated_at?: string
        }
        Update: {
          body_markdown?: string | null
          body_text?: string
          chemistry_class?: string | null
          cites_data_from_document_id?: string | null
          contact_time_seconds?: number | null
          created_at?: string
          dilution_oz_per_gal?: number | null
          document_key?: string
          document_kind?: string
          entity_id?: string | null
          epa_distributor_number?: string | null
          epa_registrant?: string | null
          epa_registrant_role?: string | null
          epa_registration?: string | null
          id?: string
          ingested_by?: string | null
          is_current?: boolean
          language_code?: string
          lifecycle_status?: string
          metadata?: Json
          product_application?: string | null
          profile_summary?: string | null
          project_number?: string | null
          source_lab?: string | null
          source_record_id?: string
          summary?: string | null
          superseded_by_document_id?: string | null
          title?: string
          token_count?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_cites_data_from_document_id_fkey"
            columns: ["cites_data_from_document_id"]
            isOneToOne: false
            referencedRelation: "document"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_cites_data_from_document_id_fkey"
            columns: ["cites_data_from_document_id"]
            isOneToOne: false
            referencedRelation: "suspect_sds_documents"
            referencedColumns: ["id"]
          },
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
          {
            foreignKeyName: "document_superseded_by_document_id_fkey"
            columns: ["superseded_by_document_id"]
            isOneToOne: false
            referencedRelation: "document"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_superseded_by_document_id_fkey"
            columns: ["superseded_by_document_id"]
            isOneToOne: false
            referencedRelation: "suspect_sds_documents"
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
          embedding_large: unknown
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
          embedding_large?: unknown
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
          embedding_large?: unknown
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
      efficacy_formula_alias: {
        Row: {
          base_formula_code: string
          created_at: string
          mca_formula_code: string
          notes: string | null
        }
        Insert: {
          base_formula_code: string
          created_at?: string
          mca_formula_code: string
          notes?: string | null
        }
        Update: {
          base_formula_code?: string
          created_at?: string
          mca_formula_code?: string
          notes?: string | null
        }
        Relationships: []
      }
      efficacy_formula_product: {
        Row: {
          created_at: string
          effective_at: string
          formula_code: string
          id: string
          is_active: boolean
          notes: string | null
          product_line_key: string | null
          registrant_role: string
          sku: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          effective_at?: string
          formula_code: string
          id?: string
          is_active?: boolean
          notes?: string | null
          product_line_key?: string | null
          registrant_role?: string
          sku?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          effective_at?: string
          formula_code?: string
          id?: string
          is_active?: boolean
          notes?: string | null
          product_line_key?: string | null
          registrant_role?: string
          sku?: string | null
          updated_at?: string
        }
        Relationships: []
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
      product_alias: {
        Row: {
          alias: string
          alias_norm: string
          alias_type: string
          confidence: number
          created_at: string
          entity_id: string | null
          id: string
          product_line_key: string
          reviewed_at: string | null
          reviewed_by: string | null
          source: string
          verified: boolean
        }
        Insert: {
          alias: string
          alias_norm: string
          alias_type?: string
          confidence?: number
          created_at?: string
          entity_id?: string | null
          id?: string
          product_line_key: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string
          verified?: boolean
        }
        Update: {
          alias?: string
          alias_norm?: string
          alias_type?: string
          confidence?: number
          created_at?: string
          entity_id?: string | null
          id?: string
          product_line_key?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string
          verified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "product_alias_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "entity"
            referencedColumns: ["id"]
          },
        ]
      }
      product_efficacy: {
        Row: {
          claim_type: string | null
          confidence: number
          contact_time_seconds: number | null
          dilution_oz_per_gal: number | null
          entity_id: string
          epa_registration: string | null
          id: string
          organism: string
          product_key: string | null
          source_page: number | null
          source_record_id: string | null
          updated_at: string
        }
        Insert: {
          claim_type?: string | null
          confidence?: number
          contact_time_seconds?: number | null
          dilution_oz_per_gal?: number | null
          entity_id: string
          epa_registration?: string | null
          id?: string
          organism: string
          product_key?: string | null
          source_page?: number | null
          source_record_id?: string | null
          updated_at?: string
        }
        Update: {
          claim_type?: string | null
          confidence?: number
          contact_time_seconds?: number | null
          dilution_oz_per_gal?: number | null
          entity_id?: string
          epa_registration?: string | null
          id?: string
          organism?: string
          product_key?: string | null
          source_page?: number | null
          source_record_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_efficacy_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "entity"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_efficacy_source_record_id_fkey"
            columns: ["source_record_id"]
            isOneToOne: false
            referencedRelation: "source_record"
            referencedColumns: ["id"]
          },
        ]
      }
      product_line_fact: {
        Row: {
          chemistry_class: string | null
          confidence: number
          contact_time_seconds: number | null
          coverage_sq_ft: number | null
          dilution_display: string | null
          dilution_oz_per_gal: number | null
          entity_id: string
          epa_registration: string | null
          id: string
          product_application: string | null
          product_application_confidence: number | null
          product_application_source: string | null
          product_key: string | null
          source_record_id: string | null
          updated_at: string
        }
        Insert: {
          chemistry_class?: string | null
          confidence?: number
          contact_time_seconds?: number | null
          coverage_sq_ft?: number | null
          dilution_display?: string | null
          dilution_oz_per_gal?: number | null
          entity_id: string
          epa_registration?: string | null
          id?: string
          product_application?: string | null
          product_application_confidence?: number | null
          product_application_source?: string | null
          product_key?: string | null
          source_record_id?: string | null
          updated_at?: string
        }
        Update: {
          chemistry_class?: string | null
          confidence?: number
          contact_time_seconds?: number | null
          coverage_sq_ft?: number | null
          dilution_display?: string | null
          dilution_oz_per_gal?: number | null
          entity_id?: string
          epa_registration?: string | null
          id?: string
          product_application?: string | null
          product_application_confidence?: number | null
          product_application_source?: string | null
          product_key?: string | null
          source_record_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_line_fact_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "entity"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_line_fact_source_record_id_fkey"
            columns: ["source_record_id"]
            isOneToOne: false
            referencedRelation: "source_record"
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
        Insert: {
          body_text?: never
          document_key?: never
          entity_key?: string | null
          entity_type?: never
          language_code?: never
          metadata?: never
          product_key?: never
          product_line_key?: string | null
          sku?: never
          source_pk?: string | null
          source_schema?: never
          source_table?: never
          source_type?: never
          title?: never
        }
        Update: {
          body_text?: never
          document_key?: never
          entity_key?: string | null
          entity_type?: never
          language_code?: never
          metadata?: never
          product_key?: never
          product_line_key?: string | null
          sku?: never
          source_pk?: string | null
          source_schema?: never
          source_table?: never
          source_type?: never
          title?: never
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
        Insert: {
          body_text?: never
          document_key?: never
          entity_key?: string | null
          entity_type?: never
          language_code?: never
          metadata?: never
          product_line_key?: never
          sku?: string | null
          source_pk?: string | null
          source_schema?: never
          source_table?: never
          source_type?: never
          title?: never
        }
        Update: {
          body_text?: never
          document_key?: never
          entity_key?: string | null
          entity_type?: never
          language_code?: never
          metadata?: never
          product_line_key?: never
          sku?: string | null
          source_pk?: string | null
          source_schema?: never
          source_table?: never
          source_type?: never
          title?: never
        }
        Relationships: []
      }
      product_alias_conflicts: {
        Row: {
          alias: string | null
          alias_norm: string | null
          alias_type: string | null
          confidence: number | null
          created_at: string | null
          entity_id: string | null
          product_line_key: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          source: string | null
          verified: boolean | null
        }
        Insert: {
          alias?: string | null
          alias_norm?: string | null
          alias_type?: string | null
          confidence?: number | null
          created_at?: string | null
          entity_id?: string | null
          product_line_key?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string | null
          verified?: boolean | null
        }
        Update: {
          alias?: string | null
          alias_norm?: string | null
          alias_type?: string | null
          confidence?: number | null
          created_at?: string | null
          entity_id?: string | null
          product_line_key?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string | null
          verified?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "product_alias_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "entity"
            referencedColumns: ["id"]
          },
        ]
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
          p_title: string
        }
        Returns: {
          chunk_index: number
          chunk_text: string
          heading: string
          section_path: string[]
          token_count: number
        }[]
      }
      chunk_efficacy_document_text: {
        Args: {
          p_body_markdown: string
          p_max_chars?: number
          p_overlap_chars?: number
          p_title?: string
        }
        Returns: {
          chunk_index: number
          chunk_text: string
          heading: string
          section_path: string[]
          section_type: string
          token_count: number
        }[]
      }
      chunk_sds_document_text: {
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
      compute_chunk_pairwise_similarity: {
        Args: { p_chunk_ids: string[] }
        Returns: {
          chunk_id_a: string
          chunk_id_b: string
          cosine_similarity: number
        }[]
      }
      enrich_sds_section_headings_batch: {
        Args: { p_batch_size?: number }
        Returns: Json
      }
      estimate_chunk_tokens: { Args: { p_text: string }; Returns: number }
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
      get_current_efficacy_for_product: {
        Args: { p_product_line_key: string }
        Returns: {
          body_markdown: string | null
          body_text: string
          chemistry_class: string | null
          cites_data_from_document_id: string | null
          contact_time_seconds: number | null
          created_at: string
          dilution_oz_per_gal: number | null
          document_key: string
          document_kind: string
          entity_id: string | null
          epa_distributor_number: string | null
          epa_registrant: string | null
          epa_registrant_role: string | null
          epa_registration: string | null
          id: string
          is_current: boolean
          language_code: string
          lifecycle_status: string
          metadata: Json
          product_application: string | null
          profile_summary: string | null
          project_number: string | null
          source_lab: string | null
          source_record_id: string
          summary: string | null
          superseded_by_document_id: string | null
          title: string
          token_count: number | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "document"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      match_corpus_chunks: {
        Args: {
          filter_product_key?: string
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
          filter_product_key?: string
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
      match_product_alias_fuzzy: {
        Args: {
          max_results?: number
          query: string
          similarity_threshold?: number
        }
        Returns: {
          alias: string
          alias_norm: string
          alias_type: string
          confidence: number
          entity_id: string
          product_line_key: string
          similarity: number
          verified: boolean
        }[]
      }
      match_product_chunks: {
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
      match_product_chunks_hybrid: {
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
      run_bulk_sds_heading_backfill: { Args: never; Returns: Json }
      sync_efficacy_chunks: {
        Args: {
          p_language_code?: string
          p_max_chars?: number
          p_overlap_chars?: number
        }
        Returns: Json
      }
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

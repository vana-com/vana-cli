/**
 * Response DTO for refiner ingestion statistics
 * Based on RefinerIngestionStatusResponse from the query engine API
 */
export interface RefinerIngestionStatsResponse {
  /** The ID of the refiner */
  refiner_id: number;
  
  /** Total number of file contributions (individual file ingestions) */
  total_file_contributions: number;
  
  /** Total number of data rows ingested across all tables */
  total_data_rows: number;
  
  /** Timestamp of the first data point ingested */
  first_ingestion_at?: string;
  
  /** Timestamp of the last data point ingested */
  last_ingestion_at?: string;
  
  /** Total number of queries executed for this refiner */
  total_queries_executed: number;
  
  /** Number of successful queries */
  successful_queries: number;
  
  /** Number of failed queries */
  failed_queries: number;
  
  /** Number of query errors by error type, sorted by highest count */
  query_errors_by_type: Record<string, number>;
  
  /** Average file contributions ingested per hour */
  average_ingestion_rate_per_hour: number;
  
  /** Number of days between first and last ingestion */
  ingestion_period_days?: number;
  
  /** Number of unique wallet addresses that contributed data */
  unique_contributors: number;
  
  /** Number of rows per table */
  rows_per_table: Record<string, number>;
  
  /** Last block number processed for ingestion */
  last_processed_block?: number;
}

/**
 * Example response data structure
 */
export const EXAMPLE_REFINER_STATS: RefinerIngestionStatsResponse = {
  refiner_id: 1,
  total_file_contributions: 234,
  total_data_rows: 15420,
  first_ingestion_at: "2024-01-15T10:30:00Z",
  last_ingestion_at: "2024-01-20T14:45:00Z",
  total_queries_executed: 87,
  successful_queries: 82,
  failed_queries: 5,
  query_errors_by_type: {
    "SQL_VALIDATION_ERROR": 3,
    "PERMISSION_ERROR": 2
  },
  average_ingestion_rate_per_hour: 2.1,
  ingestion_period_days: 5.18,
  unique_contributors: 234,
  rows_per_table: {
    "users": 5420,
    "posts": 8000,
    "comments": 2000
  },
  last_processed_block: 2945678
};

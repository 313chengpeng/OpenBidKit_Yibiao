import type {
  EmbeddingModelConfig,
  FileParserConfig,
  ImageModelConfig,
  ImageModelProfiles,
  TextModelConfig,
  TextModelProfiles,
  TextModelProvider,
  UpdateChannel,
} from '../../shared/types';

export interface SettingsPageState {
  textModel: Omit<TextModelConfig, 'context_length_limit' | 'concurrency_limit'> & {
    context_length_limit: number | '';
    concurrency_limit: number | '';
    provider: TextModelProvider;
  };
  textModelProfiles: TextModelProfiles;
  imageModel: Omit<ImageModelConfig, 'concurrency_limit'> & {
    concurrency_limit: number | '';
  };
  imageModelProfiles: ImageModelProfiles;
  embeddingModel: Omit<EmbeddingModelConfig, 'dimensions' | 'batch_size'> & {
    dimensions: number | '';
    batch_size: number | '';
  };
  fileParser: FileParserConfig;
  general: {
    developer_mode: boolean;
    update_channel: UpdateChannel;
    gpu_hardware_acceleration_enabled: boolean;
    gpu_hardware_acceleration_configured: boolean;
  };
}

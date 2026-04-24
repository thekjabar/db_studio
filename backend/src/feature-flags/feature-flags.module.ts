import { Module } from '@nestjs/common';
import { FeatureFlagsService } from './feature-flags.service';
import { FlagsController, OperatorFlagsController } from './feature-flags.controller';
import { OperatorModule } from '../operator/operator.module';

@Module({
  imports: [OperatorModule],
  controllers: [FlagsController, OperatorFlagsController],
  providers: [FeatureFlagsService],
  exports: [FeatureFlagsService],
})
export class FeatureFlagsModule {}

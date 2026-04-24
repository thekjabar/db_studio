import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { KeyProviderService } from './key-provider.service';

@Global()
@Module({
  providers: [KeyProviderService, CryptoService],
  exports: [CryptoService, KeyProviderService],
})
export class CryptoModule {}

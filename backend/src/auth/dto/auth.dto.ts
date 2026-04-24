import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';

export class SignupDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(12, 128, { message: 'Password must be 12-128 chars' })
  @Matches(/[A-Z]/, { message: 'Password must contain uppercase' })
  @Matches(/[a-z]/, { message: 'Password must contain lowercase' })
  @Matches(/[0-9]/, { message: 'Password must contain a digit' })
  password!: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  displayName?: string;

  /// Invite code. Required only when REQUIRE_INVITE_CODE_ON_SIGNUP is on —
  /// the service-side gate validates and decrements.
  @IsOptional()
  @IsString()
  @Length(1, 64)
  inviteCode?: string;
}

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(1, 128)
  password!: string;

  @IsOptional()
  @IsString()
  @Length(6, 8)
  totpCode?: string;
}

export class EnableTotpDto {
  @IsString()
  @Length(6, 8)
  code!: string;
}

export class VerifyTotpDto {
  @IsString()
  @Length(6, 8)
  code!: string;
}

export class DisableTotpDto {
  @IsString()
  @Length(1, 128)
  password!: string;

  @IsString()
  @Length(6, 8)
  code!: string;
}

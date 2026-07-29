import {
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export const GOOGLE_REGISTRATION_USERNAME_PATTERN = /^[A-Za-z0-9._]+$/u;

export const GOOGLE_REGISTRATION_PHONE_PATTERN = /^0[0-9]{9,10}$/u;

export const GOOGLE_REGISTRATION_FULLNAME_PATTERN = /^[^\p{Cc}]+$/u;

export class CompleteGoogleOAuthRegistrationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  @Matches(GOOGLE_REGISTRATION_USERNAME_PATTERN)
  username!: string;

  @IsString()
  @Matches(GOOGLE_REGISTRATION_PHONE_PATTERN)
  phone!: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Matches(GOOGLE_REGISTRATION_FULLNAME_PATTERN)
  fullname?: string;
}

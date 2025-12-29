import { FastifyReply, FastifyRequest } from 'fastify';
import { EchoService } from '@test-socket/feature-first-test';
import { Controller, Post, Req, Res } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';

@Controller('/echo')
export class EchoController {
  constructor(private readonly service: EchoService = new EchoService()) {}

  @Post()
  @ApiOperation({ summary: 'Echo Endpunkt' })
  async echo(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return res.send(this.service.echo(req.body));
  }
}
